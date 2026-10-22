import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

/** A fresh, capability-free JS runtime for each agent-authored function. */
export class SnippetSandbox {
  private constructor(private readonly quickjs: QuickJSWASMModule) {}

  static async create(): Promise<SnippetSandbox> {
    return new SnippetSandbox(await getQuickJS());
  }

  run<T>(source: string, context: unknown, now: number, timeoutMs = 100): T {
    if (typeof source !== 'string' || source.length > 32_000) {
      throw new Error('Behavior must be a JavaScript function under 32 KB.');
    }
    const input = JSON.stringify(context);
    if (input.length > 1_000_000) throw new Error('Behavior context is too large.');
    const runtime = this.quickjs.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    let deadline = Infinity;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
      // No host functions, modules, timers, network, filesystem, or process are exposed.
      // Date() and Date.now() both use the supplied clock, including during time travel.
      const script = `(() => {
        const RealDate = Date;
        const clock = ${JSON.stringify(now)};
        globalThis.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [clock])); }
          static now() { return clock; }
        };
        const context = ${input};
        const result = (${source.trim().replace(/;\s*$/, '')})(context);
        if (result && typeof result.then === 'function') throw new Error('Behaviors must be synchronous.');
        const json = JSON.stringify(result);
        if (typeof json !== 'string' || json.length > 128000) throw new Error('Behavior must return a JSON value under 128 KB.');
        return json;
      })()`;
      deadline = Date.now() + timeoutMs;
      const result = vm.evalCode(script, 'agent-behavior.js');
      if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new Error(typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Behavior execution failed.');
      }
      try {
        return JSON.parse(vm.getString(result.value)) as T;
      } finally {
        result.value.dispose();
      }
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  }
}
