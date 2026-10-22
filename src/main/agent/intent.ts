import type { Action, Routine } from '../../shared/types';

export interface ArtifactIntent {
  list: boolean;
  routine: boolean;
  linkedListId?: string;
  navigation?: boolean;
}

export function isCompletionHistoryRequest(request: string): boolean {
  const text = request.toLowerCase();
  return /\b(?:show|view|list|bring back|find)\b[^.!?]{0,100}\b(?:(?:what|everything|things) i (?:finished|completed|did)|(?:finished|completed|done) (?:tasks|items|things)|(?:tasks|items|things) (?:i )?(?:finished|completed|did))\b/.test(text)
    || /\bwhat (?:did|have) i (?:finish(?:ed)?|complete(?:d)?)\b|\bwhat (?:did|have) i do(?:ne)? (?:today|yesterday|this (?:morning|week)|last week)\b/.test(text);
}

/** Conservative postcondition detection; this is not the agent's language understanding. */
export function artifactIntent(request: string, routine?: Routine): ArtifactIntent {
  if (routine?.listId) return { list: true, routine: false, linkedListId: routine.listId };
  if (routine) return { list: false, routine: false };
  const text = request.toLowerCase();
  const appQuestion = /\b(?:settings|api key|billing|model provider|app version|install|uninstall)\b/.test(text)
    || /\b(?:how (?:do|does|can) (?:this|the app|you)|explain how|what (?:is|are) (?:a|the) (?:list|routine)|how (?:do|does) (?:lists|routines))\b/.test(text);
  if (appQuestion) return { list: false, routine: false };
  const recommendations = /\bwhat (?:can|should|could) i (?:do|work on|focus on|tackle|finish)\b/.test(text)
    || /\b(?:pick|choose|select|recommend|suggest|prioritize|rank)\b[^.!?]{0,100}\b(?:things|tasks|priorities|items|actions|work|steps)\b/.test(text)
    || /\bwhat (?:are|is) my (?:top |highest )?priorit(?:y|ies)\b/.test(text);
  const subset = /\b(?:make|create|build|show|give|refresh|update|sort|filter|organize|find|want|need)\b[^.!?]{0,100}\b(?:list|subset|shortlist|priorities|tasks|things to do)\b/.test(text);
  const list = recommendations || subset || isCompletionHistoryRequest(text);
  const recurring = /\b(?:every|each) (?:morning|day|evening|night|week)\b|\bdaily\b/.test(text);
  const navigation = /\b(?:show|open|view|switch to|go to)\b[^.!?]{0,100}\blist\b/.test(text);
  return { list: list || navigation, routine: list && recurring, navigation };
}

export function missingArtifacts(intent: ArtifactIntent, actions: Action[]): string[] {
  const missing: string[] = [];
  const listActions = actions.filter(action => action.type === 'create_list' || action.type === 'update_list' || action.type === 'refresh_list');
  if (intent.linkedListId) {
    if (!listActions.some(action => action.type !== 'create_list' && action.id === intent.linkedListId)) {
      missing.push(`update or refresh the existing linked list ${intent.linkedListId}`);
    }
  } else if (intent.list && !listActions.length && !(intent.navigation && actions.some(action => action.type === 'show_list'))) {
    missing.push(intent.navigation ? 'open the existing list with show_list, or create it if it does not exist' : 'create, update, or refresh an actual custom list in the app (temporary for an ad-hoc selection)');
  }
  if (intent.routine && !actions.some(action => action.type === 'create_routine' || action.type === 'update_routine')) {
    missing.push('create or update the recurring routine linked to that list');
  }
  return missing;
}
