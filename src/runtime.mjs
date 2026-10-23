import { getSdk, resolveCachedModel } from '../shared/qvac.mjs';
import { QuoteError, createToolHandlers, orchestrateQuote, validateRequest } from './core.mjs';

export function createQuoteRuntime({ datasets, sdkProvider = getSdk, modelResolver = resolveCachedModel, env = process.env, now = () => new Date() }) {
  const state = { phase: 'idle', model: env.QUOTE_MODEL_PATH ? 'Custom local model' : 'Qwen3 1.7B Q4', modelId: null, progress: null, error: null, busy: false, stage: null };
  let loading;
  let sdkInstance;
  let activeRequestId;
  let closing = false;

  const status = () => ({ ...state, sdkVersion: '0.22.0', modelExport: 'QWEN3_1_7B_INST_Q4', customLocalModel: Boolean(env.QUOTE_MODEL_PATH), syntheticData: true });

  async function load() {
    if (closing) throw new QuoteError('The app is shutting down.', 409);
    if (state.modelId) return status();
    if (loading) return loading;
    state.phase = 'loading';
    state.error = null;
    state.progress = 0;
    loading = (async () => {
      try {
        const sdk = await sdkProvider();
        sdkInstance = sdk;
        if (closing) throw new QuoteError('The app is shutting down.', 409);
        const local = env.QUOTE_MODEL_PATH;
        if (local && !local.startsWith('/')) throw new QuoteError('QUOTE_MODEL_PATH must be an absolute local file path.');
        const modelSrc = local || await modelResolver(sdk.QWEN3_1_7B_INST_Q4);
        if (!modelSrc) throw new QuoteError('The required Qwen3 model export is unavailable. Install @qvac/sdk 0.22.0.', 503);
        const run = sdk.loadModel({
          modelSrc,
          ...(typeof modelSrc === 'string' ? { modelType: 'llamacpp-completion' } : {}),
          modelConfig: { ctx_size: 4096, tools: true, reasoning_budget: 0 },
          onProgress: (progress) => { state.progress = Number.isFinite(progress.percentage) ? Math.round(progress.percentage) : null; }
        });
        activeRequestId = run.requestId;
        state.modelId = await run;
        state.phase = 'ready';
        state.progress = 100;
        return status();
      } catch (error) {
        state.phase = 'error';
        state.error = String(error.message ?? error);
        throw error;
      } finally { loading = undefined; activeRequestId = undefined; }
    })();
    return loading;
  }

  async function unload() {
    if (state.busy || loading) throw new QuoteError('Wait for the current task before unloading.', 409);
    if (state.modelId) {
      const sdk = await sdkProvider();
      await sdk.unloadModel({ modelId: state.modelId, clearStorage: false });
    }
    Object.assign(state, { phase: 'idle', modelId: null, progress: null, error: null, stage: null });
    return status();
  }

  async function quote(body) {
    if (closing) throw new QuoteError('The app is shutting down.', 409);
    const request = validateRequest(body, datasets, now());
    if (!state.modelId) throw new QuoteError('Load the local model before preparing a quote.', 409);
    if (state.busy) throw new QuoteError('A quote is already running. Wait for it to finish.', 409);
    state.busy = true;
    state.error = null;
    try {
      const sdk = await sdkProvider();
      sdkInstance = sdk;
      const complete = async ({ history, tools, finalTurn }) => {
        if (closing) throw new QuoteError('The app is shutting down.', 409);
        state.stage = finalTurn ? 'Writing the short model note' : 'Local model is choosing tools';
        const run = sdk.completion({
          modelId: state.modelId,
          history,
          stream: true,
          ...(tools ? { tools } : {}),
          generationParams: { temp: 0, predict: finalTurn ? 180 : 768, reasoning_budget: 0, ...(tools ? { tool_choice: 'required', parallel_tool_calls: true } : {}) }
        });
        activeRequestId = run.requestId;
        let timer;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              void sdk.cancel({ requestId: run.requestId }).catch(() => {});
              reject(new QuoteError('The local model took more than 120 seconds. Try again or unload the model.', 504));
            }, 120_000);
          });
          return await Promise.race([run.final, timeout]);
        } finally { clearTimeout(timer); activeRequestId = undefined; }
      };
      const result = await orchestrateQuote({ request, complete, handlers: createToolHandlers(datasets, now), now });
      return { ...result, model: state.model, sdkVersion: '0.22.0' };
    } catch (error) {
      state.error = String(error.message ?? error);
      throw error;
    } finally { state.busy = false; state.stage = null; }
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (!sdkInstance) return;
    if (activeRequestId) await sdkInstance.cancel({ requestId: activeRequestId }).catch(() => {});
    if (state.modelId) await sdkInstance.unloadModel({ modelId: state.modelId, clearStorage: false }).catch(() => {});
    await sdkInstance.close();
    Object.assign(state, { phase: 'closed', modelId: null, busy: false, stage: null });
  }

  return { status, load, unload, quote, close };
}
