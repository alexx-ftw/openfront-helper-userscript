// Popup styling — extends the in-game floating-panel aesthetic (dark glassy
// teal, soft green accents, Aptos/Segoe). All rules are scoped under
// #openfront-helper-popup / .ofh- so nothing leaks into the game. style-src
// 'unsafe-inline' is allowed by the page CSP, so a plain <style> is fine.

export const POPUP_STYLE_ID = "openfront-helper-popup-styles";

export const POPUP_CSS = `
#openfront-helper-popup-overlay {
  position: fixed; inset: 0; z-index: 2147483646;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 50% 30%, rgba(4,16,14,.55), rgba(0,0,0,.72));
  backdrop-filter: blur(2px);
  animation: ofh-fade .16s ease-out;
}
@keyframes ofh-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes ofh-rise { from { opacity: 0; transform: translateY(10px) scale(.98) } to { opacity: 1; transform: none } }

#openfront-helper-popup {
  width: min(720px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  color: #eef2f0;
  font-family: "Aptos", "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
  border: 1px solid rgba(134, 239, 172, 0.30);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(34, 197, 94, 0.14), transparent 42%),
    radial-gradient(circle at 88% 4%, rgba(56, 189, 248, 0.07), transparent 30%),
    rgba(7, 24, 22, 0.97);
  box-shadow: 0 24px 64px rgba(0,0,0,.55), inset 0 1px 0 rgba(187,247,208,.12);
  animation: ofh-rise .2s cubic-bezier(.2,.8,.2,1);
  overflow: hidden;
}

#openfront-helper-popup .ofh-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(134, 239, 172, 0.16);
  background: rgba(7, 24, 22, 0.6);
}
#openfront-helper-popup .ofh-head h1 {
  margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .3px; color: #d1fae5;
  display: flex; align-items: center; gap: 8px;
}
#openfront-helper-popup .ofh-head .ofh-ver {
  font-size: 11px; font-weight: 600; color: rgba(187,247,208,.55);
  border: 1px solid rgba(187,247,208,.2); border-radius: 999px; padding: 1px 8px;
}
#openfront-helper-popup .ofh-spacer { flex: 1; }
#openfront-helper-popup .ofh-x {
  cursor: pointer; border: 1px solid rgba(248,113,113,.34); color: #fecaca;
  background: rgba(69,10,10,.4); border-radius: 8px; width: 30px; height: 30px;
  font-size: 16px; line-height: 1; display: grid; place-items: center; transition: .15s;
}
#openfront-helper-popup .ofh-x:hover { background: rgba(127,29,29,.6); }

#openfront-helper-popup .ofh-tabs {
  display: flex; gap: 4px; padding: 10px 14px 0; flex-wrap: wrap;
}
#openfront-helper-popup .ofh-tab {
  cursor: pointer; border: 1px solid transparent; border-radius: 9px 9px 0 0;
  padding: 8px 14px; font-size: 12px; font-weight: 700; letter-spacing: .4px;
  text-transform: uppercase; color: rgba(187,247,208,.6); background: transparent;
  transition: .15s;
}
#openfront-helper-popup .ofh-tab:hover { color: #d1fae5; }
#openfront-helper-popup .ofh-tab.active {
  color: #ecfdf5; background: rgba(16, 185, 129, 0.14);
  border-color: rgba(134,239,172,.28); border-bottom-color: transparent;
}

/* sub-tabs (Filters / Maps under Auto-Join) */
#openfront-helper-popup .ofh-subtabs { display: flex; gap: 6px; margin-bottom: 14px; }
#openfront-helper-popup .ofh-subtab {
  cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .3px;
  padding: 6px 13px; border-radius: 999px; color: rgba(187,247,208,.6);
  background: rgba(8,31,28,.6); border: 1px solid rgba(151,181,214,.16); transition: .14s;
}
#openfront-helper-popup .ofh-subtab:hover { color: #d1fae5; border-color: rgba(134,239,172,.3); }
#openfront-helper-popup .ofh-subtab.on {
  color: #06281f; background: linear-gradient(135deg, #34d399, #10b981);
  border-color: rgba(187,247,208,.5);
}

/* searchable language dropdown */
#openfront-helper-popup .ofh-dd { position: relative; max-width: 300px; }
#openfront-helper-popup .ofh-dd-btn {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; font: 600 13px "Aptos", "Segoe UI", sans-serif; color: #eef2f0;
  background: rgba(3,12,11,.7); border: 1px solid rgba(151,181,214,.2);
  border-radius: 9px; padding: 9px 12px; transition: .14s;
}
#openfront-helper-popup .ofh-dd-btn:hover { border-color: rgba(134,239,172,.4); }
#openfront-helper-popup .ofh-dd-caret { opacity: .6; font-size: 10px; }
#openfront-helper-popup .ofh-dd-menu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5;
  background: #0b1620; border: 1px solid rgba(134,239,172,.28); border-radius: 10px;
  box-shadow: 0 14px 34px rgba(0,0,0,.55); overflow: hidden;
}
#openfront-helper-popup .ofh-dd-menu[hidden] { display: none; }
#openfront-helper-popup .ofh-dd-search {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; color: #eef2f0;
  background: rgba(0,0,0,.3); border: none;
  border-bottom: 1px solid rgba(151,181,214,.16); padding: 9px 12px; outline: none;
}
#openfront-helper-popup .ofh-dd-list { max-height: 220px; overflow-y: auto; }
#openfront-helper-popup .ofh-dd-list::-webkit-scrollbar { width: 8px; }
#openfront-helper-popup .ofh-dd-list::-webkit-scrollbar-thumb { background: rgba(134,239,172,.22); border-radius: 999px; }
#openfront-helper-popup .ofh-dd-item {
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; padding: 8px 12px; font-size: 13px; color: rgba(226,232,240,.85); transition: .12s;
}
#openfront-helper-popup .ofh-dd-item:hover { background: rgba(16,185,129,.14); color: #ecfdf5; }
#openfront-helper-popup .ofh-dd-item.on { color: #06281f; background: linear-gradient(135deg, #34d399, #10b981); }
#openfront-helper-popup .ofh-dd-code { font-size: 10px; opacity: .55; font-weight: 700; letter-spacing: .5px; }
#openfront-helper-popup .ofh-dd-empty { padding: 12px; text-align: center; font-size: 12px; color: rgba(187,247,208,.5); }

#openfront-helper-popup .ofh-body { padding: 16px 18px 20px; overflow-y: auto; }
#openfront-helper-popup .ofh-body::-webkit-scrollbar { width: 9px; }
#openfront-helper-popup .ofh-body::-webkit-scrollbar-thumb {
  background: rgba(134,239,172,.22); border-radius: 999px;
}

#openfront-helper-popup .ofh-section-title {
  font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: rgba(187,247,208,.5); margin: 4px 0 10px;
}
#openfront-helper-popup .ofh-grid { display: grid; gap: 8px; }
#openfront-helper-popup .ofh-grid.cols2 { grid-template-columns: 1fr 1fr; }

/* row: label + control */
#openfront-helper-popup .ofh-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid rgba(151, 181, 214, 0.14);
  background: rgba(8, 31, 28, 0.6);
  transition: .15s;
}
#openfront-helper-popup .ofh-row:hover { border-color: rgba(134,239,172,.26); background: rgba(10,38,34,.7); }
#openfront-helper-popup .ofh-row .ofh-txt { flex: 1; min-width: 0; }
#openfront-helper-popup .ofh-row .ofh-name { font-size: 13px; font-weight: 600; color: #eef2f0; }
#openfront-helper-popup .ofh-row .ofh-desc { font-size: 11px; color: rgba(187,247,208,.55); margin-top: 2px; line-height: 1.4; }

/* pill switch */
#openfront-helper-popup .ofh-switch {
  position: relative; width: 40px; height: 22px; flex: none; cursor: pointer;
  border-radius: 999px; background: rgba(120,120,120,.28);
  border: 1px solid rgba(255,255,255,.1); transition: .18s;
}
#openfront-helper-popup .ofh-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #e5e7eb; transition: .18s;
  box-shadow: 0 1px 3px rgba(0,0,0,.4);
}
#openfront-helper-popup .ofh-switch.on { background: linear-gradient(135deg,#22c55e,#10b981); border-color: rgba(187,247,208,.5); }
#openfront-helper-popup .ofh-switch.on::after { left: 20px; background: #ecfdf5; }
#openfront-helper-popup .ofh-switch.disabled { opacity: .4; cursor: not-allowed; }

/* chip toggle (filters / presets) */
#openfront-helper-popup .ofh-chips { display: flex; flex-wrap: wrap; gap: 7px; }
#openfront-helper-popup .ofh-chip {
  cursor: pointer; user-select: none; font-size: 12px; font-weight: 600;
  padding: 7px 12px; border-radius: 999px; transition: .14s;
  border: 1px solid rgba(151,181,214,.18); background: rgba(8,31,28,.6); color: rgba(226,232,240,.8);
}
#openfront-helper-popup .ofh-chip:hover { border-color: rgba(134,239,172,.3); }
#openfront-helper-popup .ofh-chip.on {
  color: #06281f; background: linear-gradient(135deg,#34d399,#10b981);
  border-color: rgba(187,247,208,.6); box-shadow: 0 4px 14px rgba(16,185,129,.25);
}
#openfront-helper-popup .ofh-chip.exclude.on {
  color: #2a0a0a; background: linear-gradient(135deg,#fca5a5,#f87171); border-color: rgba(254,202,202,.6);
  box-shadow: 0 4px 14px rgba(248,113,113,.25);
}

#openfront-helper-popup .ofh-field { display: flex; align-items: center; gap: 8px; }
#openfront-helper-popup .ofh-field label { font-size: 12px; color: rgba(187,247,208,.7); }
#openfront-helper-popup input.ofh-num {
  width: 70px; font: inherit; font-size: 13px; color: #eef2f0;
  background: rgba(3,12,11,.7); border: 1px solid rgba(151,181,214,.2);
  border-radius: 8px; padding: 6px 8px;
}
#openfront-helper-popup input.ofh-num:focus { outline: none; border-color: rgba(52,211,153,.6); }

/* map grid */
#openfront-helper-popup .ofh-maps {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px;
}
#openfront-helper-popup .ofh-map {
  cursor: pointer; border-radius: 10px; overflow: hidden; position: relative;
  border: 1px solid rgba(151,181,214,.16); background: rgba(3,12,11,.6); transition: .15s;
}
#openfront-helper-popup .ofh-map:hover { transform: translateY(-2px); border-color: rgba(134,239,172,.3); }
#openfront-helper-popup .ofh-map.on { border-color: rgba(52,211,153,.8); box-shadow: 0 0 0 2px rgba(52,211,153,.3); }
#openfront-helper-popup .ofh-map .ofh-thumb {
  width: 100%; aspect-ratio: 2/1; object-fit: cover; display: block; background: rgba(0,0,0,.3);
}
#openfront-helper-popup .ofh-map .ofh-noimg {
  width: 100%; aspect-ratio: 2/1; display: grid; place-items: center;
  font-size: 22px; color: rgba(187,247,208,.4); background: rgba(8,31,28,.7);
}
#openfront-helper-popup .ofh-map .ofh-mapname {
  font-size: 11px; font-weight: 600; text-align: center; padding: 6px 4px;
  color: #dbeafe; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#openfront-helper-popup .ofh-map .ofh-check {
  position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; border-radius: 50%;
  background: rgba(16,185,129,.95); color: #06281f; display: none; place-items: center;
  font-size: 13px; font-weight: 800;
}
#openfront-helper-popup .ofh-map.on .ofh-check { display: grid; }

#openfront-helper-popup .ofh-note {
  font-size: 11px; color: rgba(187,247,208,.5); margin: 12px 2px 0; line-height: 1.5;
}

/* external link card (About → GitHub) */
#openfront-helper-popup .ofh-link {
  display: flex; align-items: center; gap: 11px; margin-top: 10px; text-decoration: none;
  padding: 11px 13px; border-radius: 10px; color: #d1fae5;
  border: 1px solid rgba(151,181,214,.18); background: rgba(8,31,28,.6); transition: .15s;
}
#openfront-helper-popup .ofh-link:hover {
  border-color: rgba(134,239,172,.4); background: rgba(10,38,34,.72); transform: translateY(-1px);
}
#openfront-helper-popup .ofh-link-ico {
  flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px;
  font-size: 15px; color: #fde68a; background: rgba(250,204,21,.12); border: 1px solid rgba(250,204,21,.25);
}
#openfront-helper-popup .ofh-link-body { flex: 1; min-width: 0; }
#openfront-helper-popup .ofh-link-title { font-size: 13px; font-weight: 700; }
#openfront-helper-popup .ofh-link-sub { font-size: 11px; color: rgba(187,247,208,.55); margin-top: 1px; }
#openfront-helper-popup .ofh-link-arrow { flex: none; opacity: .5; font-size: 14px; }
#openfront-helper-popup .ofh-link:hover .ofh-link-arrow { opacity: .9; }
#openfront-helper-popup .ofh-btn {
  cursor: pointer; font: inherit; font-size: 12px; font-weight: 700;
  padding: 8px 14px; border-radius: 9px; color: #ecfdf5;
  border: 1px solid rgba(134,239,172,.3); background: rgba(16,185,129,.16); transition: .15s;
}
#openfront-helper-popup .ofh-btn:hover { background: rgba(16,185,129,.28); }

/* atom tab — teal system with red used only as a danger accent */
#openfront-helper-popup .ofh-atom-hero {
  display: flex; gap: 13px; align-items: flex-start;
  padding: 13px 14px; border-radius: 12px; margin-bottom: 2px;
  border: 1px solid rgba(248,113,113,.22);
  background:
    linear-gradient(135deg, rgba(248,113,113,.10), transparent 55%),
    rgba(8, 31, 28, 0.55);
}
#openfront-helper-popup .ofh-atom-hero-ico {
  flex: none; font-size: 22px; line-height: 1; margin-top: 1px;
  filter: drop-shadow(0 0 8px rgba(248,113,113,.5));
}
#openfront-helper-popup .ofh-atom-hero-body { flex: 1; min-width: 0; }
#openfront-helper-popup .ofh-atom-hero-desc { font-size: 12px; line-height: 1.55; color: rgba(226,232,240,.82); }
#openfront-helper-popup .ofh-atom-keyrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
#openfront-helper-popup .ofh-atom-keylbl {
  font-size: 10px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: rgba(187,247,208,.5);
}
#openfront-helper-popup .ofh-kbd {
  display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 7px;
  font: 800 13px/1 "Aptos", "Consolas", monospace; color: #fecaca;
  border: 1px solid rgba(248,113,113,.4); border-bottom-width: 2px; border-radius: 6px;
  background: rgba(127,29,29,.28); box-shadow: 0 1px 0 rgba(0,0,0,.3);
}
#openfront-helper-popup .ofh-cad {
  font-size: 12px; font-weight: 800; letter-spacing: .3px; color: #fbbf24; white-space: nowrap;
  padding: 6px 10px; border-radius: 8px;
  border: 1px solid rgba(251,191,36,.28); background: rgba(251,191,36,.10); transition: .15s;
}
#openfront-helper-popup .ofh-cad.max { color: #34d399; border-color: rgba(52,211,153,.3); background: rgba(52,211,153,.10); }

/* launcher icon */
#openfront-helper-launcher {
  position: fixed; z-index: 2147483645; width: 44px; height: 44px;
  display: flex; align-items: center; justify-content: center;
  color: #6ee7b7; cursor: grab; user-select: none; touch-action: none;
  border-radius: 50%;
  border: 1px solid rgba(134,239,172,.34);
  background:
    linear-gradient(135deg, rgba(34,197,94,.22), transparent 50%),
    rgba(7, 24, 22, 0.94);
  box-shadow: 0 6px 18px rgba(0,0,0,.5), inset 0 1px 0 rgba(187,247,208,.14);
  transition: transform .12s, box-shadow .12s;
}
#openfront-helper-launcher:hover { transform: scale(1.08); box-shadow: 0 8px 24px rgba(16,185,129,.35); }
`;
