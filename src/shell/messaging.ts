// chrome.runtime / chrome.tabs messaging collapsed to a single in-page bus.
// Everything runs in one page context, so a "message" is just a call into the
// same listener set.

type MessageListener = (
  message: unknown,
  sender: { id?: string; tab?: { id: number } },
  sendResponse: (response?: unknown) => void,
) => unknown;

const messageListeners = new Set<MessageListener>();
const SENDER = { id: "openfront-helper", tab: { id: 1 } };

function dispatch(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (response?: unknown) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    for (const listener of messageListeners) {
      try {
        const result = listener(message, SENDER, sendResponse);
        if (result instanceof Promise) {
          void result.then((value) => {
            if (value !== undefined) sendResponse(value);
          });
        }
      } catch (error) {
        console.error("[ofh] message listener threw:", error);
      }
    }
    queueMicrotask(() => {
      sendResponse();
    });
  });
}

export const runtimeOnMessage = {
  addListener: (cb: MessageListener) => {
    messageListeners.add(cb);
  },
  removeListener: (cb: MessageListener) => {
    messageListeners.delete(cb);
  },
  hasListener: (cb: MessageListener) => messageListeners.has(cb),
};

export const runtimeSendMessage = (message: unknown) => dispatch(message);

export const tabs = {
  query(): Promise<{ id: number; url: string }[]> {
    return Promise.resolve([{ id: SENDER.tab.id, url: location.href }]);
  },
  async sendMessage(_tabId: number, message: unknown): Promise<unknown> {
    return dispatch(message);
  },
  reload(): Promise<void> {
    location.reload();
    return Promise.resolve();
  },
};
