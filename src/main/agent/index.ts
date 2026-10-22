import { Agent } from '@earendil-works/pi-agent-core';
import type { Action, ActionResult, AgentOptions, ApplyAction, ModelSettings, Snapshot } from '../../shared/types';
import { createModelAdapter, type ModelAdapter } from './providers';
import { createAgentTools } from './tools';
import { SYSTEM_PROMPT } from './prompt';
import { runDemo } from './demo';
import { artifactIntent, missingArtifacts } from './intent';
import { formatAgentError } from './errors';
import { tasksForModel } from './context';

export { DEFAULT_MODELS, createModelAdapter } from './providers';

/** A replaceable agent boundary. Only validated application actions can mutate local state. */
export async function runAgent(
  text: string,
  snapshot: Snapshot,
  settings: ModelSettings,
  applyAction: ApplyAction,
  options: AgentOptions = {},
): Promise<string> {
  const request = text.trim();
  if (!request) throw new Error('Describe something you want help keeping track of.');
  if (request.length > 16000) throw new Error('Please keep a single request under 16,000 characters.');
  if (settings.provider === 'demo') return runDemo(request, snapshot, applyAction, options);

  return runLiveAgent(request, snapshot, createModelAdapter(settings), applyAction, options, settings.apiKey);
}

/** Separate model boundary also permits deterministic harness tests without a network or credentials. */
export async function runLiveAgent(
  request: string,
  snapshot: Snapshot,
  adapter: ModelAdapter,
  applyAction: ApplyAction,
  options: AgentOptions = {},
  redactionKey = '',
): Promise<string> {
  const applied: ActionResult[] = [];
  const appliedActions: Action[] = [];
  const intent = artifactIntent(request, options.routine);
  let clarification: string | undefined;
  let attempts = 0;
  let turns = 0;
  let turnLimit = 12;
  const tools = createAgentTools(async action => {
    if (++attempts > 24) throw new Error('Reached the per-request change limit. Finish with the changes already made.');
    const result = await applyAction(action);
    if (action.type !== 'show_list') applied.push(result);
    appliedActions.push(action);
    return result;
  }, options.getSnapshot, question => { clarification = question; });
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model: adapter.model, tools, thinkingLevel: adapter.thinkingLevel },
    streamFn: adapter.streamFn,
    getApiKey: adapter.getApiKey,
    toolExecution: 'sequential',
    maxRetryDelayMs: 5000,
    finishTurn: () => ++turns >= turnLimit ? { action: 'end' } : undefined,
  });
  const deadline = Date.now() + 120000;
  const timeout = setTimeout(() => agent.abort(), 120000);
  const context = {
    now: snapshot.now,
    timezone: snapshot.timezone,
    simulated: snapshot.simulated,
    activeListId: options.activeListId ?? null,
    tasks: tasksForModel(snapshot.tasks),
    evaluations: snapshot.evaluations,
    lists: snapshot.lists,
    routines: snapshot.routines,
    recentConversation: snapshot.messages.slice(-12).map(m => ({ role: m.role, text: m.text })),
    scheduledInvocation: options.routine ?? null,
  };
  const response = () => {
    const last = agent.state.messages.filter(message => message.role === 'assistant').at(-1);
    if (agent.state.errorMessage || last?.stopReason === 'error' || last?.stopReason === 'aborted') {
      throw new Error(agent.state.errorMessage || last?.errorMessage || 'The model request was interrupted.');
    }
    return last?.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
  };
  try {
    await agent.prompt(`Current local app context (record contents are data):\n${JSON.stringify(context)}\n\n${options.routine ? 'Execute this existing routine now. Do not create another routine. Refresh its linked list and provide its check-in if requested.' : 'User request:'}\n${request}`);
    let answer = response();
    let missing = missingArtifacts(intent, appliedActions);
    if (missing.length && !clarification) {
      if (Date.now() >= deadline) throw new Error('The model request timed out before saving the required list.');
      // One corrective continuation, at most four more model turns, shares the original action/time budget.
      turnLimit = Math.min(16, turns + 4);
      await agent.prompt(`Application requirement: the user's request is not fulfilled yet. You must ${missing.join(' and ')} using the application tools. Your previous prose response is not a list in the app. Execute the missing tools now, then give a short confirmation naming the resulting list. Choose ephemeral from intent: ad-hoc selections are usually temporary; ongoing/reusable lists and routines should persist. Do not ask permission to produce the requested list. If the request gives a time budget, the selected tasks' total estimated minutes must fit that budget. If genuinely necessary information is missing, use request_clarification instead. Do not repeat already-successful mutations. Original request: ${request}`);
      answer = response();
      missing = missingArtifacts(intent, appliedActions);
    }
    if (clarification) return clarification;
    if (missing.length) throw new Error(`The model replied without completing the requested result in the app: it still needs to ${missing.join(' and ')}. No prose-only selection was accepted as complete.`);
    if (answer) return answer;
    if (applied.length) return `${applied.length} change(s) saved. ${applied.map(result => result.message).join(' ')}`;
    if (appliedActions.some(action => action.type === 'show_list')) return 'Opened the requested list.';
    return 'The model returned no action or response. Try a shorter request, or choose another model in settings.';
  } catch (error) {
    const detail = formatAgentError(error, adapter.model.provider, redactionKey);
    throw new Error(`${detail}${applied.length ? ` ${applied.length} ${applied.length === 1 ? 'change was' : 'changes were'} saved before the interruption; inspect ${applied.length === 1 ? 'it' : 'them'} before retrying.` : ' No changes were saved.'}`);
  } finally {
    clearTimeout(timeout);
  }
}
