import { executeClassicScript } from "../classic-script.mjs";
import { readEngineSource } from "./context.mjs";

const RUNTIME_STATE_SHIM = `
var runtimeState = {
  lastOpenFrontGameContext: null,
  selectiveTradePolicyEnabled: false,
};
`;

export const visibleModal = () => ({
  isVisible: true,
  isConnected: true,
  classList: { contains: () => false },
});
export const hiddenModal = () => ({
  isVisible: true,
  isConnected: true,
  classList: { contains: (n) => n === "hidden" },
});
export const loc = (s, pathname, search = "") => {
  s.location = { pathname, search };
};

export function seedContextElement() {
  return { game: { playerViews: () => [] }, transformHandler: { worldToScreenCoordinates() {} } };
}

export function createContextCacheSandbox() {
  const state = {
    now: 0,
    scanCount: 0,
    elements: [],
    modal: null,
    lastModalReturned: null,
    modalQueryCount: 0,
    bodyInGame: false,
    location: {},
  };
  loc(state, "/");
  const sandbox = {
    document: {
      body: { classList: { contains: (c) => Boolean(state.bodyInGame && c === "in-game") } },
      querySelectorAll: () => {
        state.scanCount += 1;
        return state.elements;
      },
      querySelector: (s) => {
        if (s !== "game-starting-modal") return null;
        state.modalQueryCount += 1;
        state.lastModalReturned = state.modal;
        return state.modal;
      },
    },
    performance: { now: () => state.now },
    window: Object.defineProperty({}, "location", { get: () => state.location }),
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const sources = [
    RUNTIME_STATE_SHIM,
    readEngineSource("engine/ingame/trade-policy/context.js"),
    readEngineSource("engine/ingame/trade-policy/players.js"),
    readEngineSource("engine/ingame/trade-policy/partners.js"),
    readEngineSource("engine/ingame/trade-policy/apply.js"),
  ];
  executeClassicScript(sources.join("\n"), sandbox);
  return { state, sandbox };
}

export const START_SIGNAL_CASES = [
  { label: "body.in-game class", activate: (s) => (s.bodyInGame = true) },
  { label: "/game/abc1?live", activate: (s) => loc(s, "/game/abc1", "?live") },
  { label: "/w2/game/abc1?live", activate: (s) => loc(s, "/w2/game/abc1", "?live") },
  { label: "/v/<c>/w3/game?live", activate: (s) => loc(s, "/v/abc123456/w3/game/abc1", "?live") },
  { label: "visible starting modal", activate: (s) => (s.modal = visibleModal()) },
];

export const NEGATIVE_SIGNAL_CASES = [
  { label: "/game/abc1 without live", activate: (s) => loc(s, "/game/abc1") },
  { label: "/streamer-mode with live search", activate: (s) => loc(s, "/streamer-mode", "?live") },
  { label: "/v/<c>/replayhost", activate: (s) => loc(s, "/v/abc123456/replayhost") },
  { label: "hidden starting modal", activate: (s) => (s.modal = hiddenModal()) },
];

export function resetSignals(state) {
  state.bodyInGame = false;
  state.modal = null;
  if (state.lastModalReturned) state.lastModalReturned.isConnected = false;
  loc(state, "/");
}
