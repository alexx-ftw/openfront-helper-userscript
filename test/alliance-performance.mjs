import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { executeClassicScript, readRepositoryFile } from "./helpers/classic-script.mjs";

const { document } = parseHTML("<html><body></body></html>");
const sandbox = {};
executeClassicScript(readRepositoryFile("engine/ingame/alliances.js"), sandbox);

let writes = 0;
let queries = 0;
function instrument(element, method) {
  const original = element[method].bind(element);
  element[method] = (...args) => {
    writes += 1;
    return original(...args);
  };
}
function createMarker() {
  const marker = document.createElement("div");
  marker.innerHTML = '<span class="openfront-helper-ally-remaining"></span>';
  const style = marker.style;
  Object.defineProperty(marker, "style", {
    value: {
      setProperty(...args) {
        writes += 1;
        style.setProperty(...args);
      },
      getPropertyValue: style.getPropertyValue.bind(style),
    },
  });
  instrument(marker.classList, "remove");
  instrument(marker.classList, "add");
  const querySelector = marker.querySelector.bind(marker);
  marker.querySelector = (...args) => {
    queries += 1;
    return querySelector(...args);
  };
  return marker;
}
function createLine() {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  instrument(line, "setAttribute");
  instrument(line.classList, "remove");
  instrument(line.classList, "add");
  return line;
}
const marker = createMarker();
const line = createLine();
const position = { x: 120, y: 240 };
const hovered = { x: 10, y: 20 };
const timing = { remaining: "2m 0s left", urgencyClass: "" };
const update = () => sandbox.updateAllyMarker(marker, line, timing, position, hovered);
update();
assert.equal(line.getAttribute("x2"), "120");
assert.equal(marker.style.getPropertyValue("--ally-y"), "240px");
assert.equal(marker.textContent, "2m 0s left");
const originalMarker = marker.outerHTML;
const originalLine = line.outerHTML;
writes = 0;
queries = 0;
for (let frame = 0; frame < 1000; frame += 1) update();
assert.equal(writes, 0, "1000 unchanged frames must perform no DOM writes");
assert.equal(queries, 0, "unchanged countdowns must perform no DOM queries");
assert.equal(marker.outerHTML, originalMarker);
assert.equal(line.outerHTML, originalLine);

hovered.x = 30;
hovered.y = 40;
update();
assert.equal(writes, 2, "moving the hovered player updates only the two line endpoints");
assert.equal(line.getAttribute("x1"), "30");
writes = 0;
position.x = 130;
update();
assert.equal(writes, 2, "moving an ally updates its line coordinate and marker coordinate");
assert.equal(marker.style.getPropertyValue("--ally-x"), "130px");

timing.remaining = "1m 59s left";
queries = 0;
update();
assert.equal(queries, 1);
assert.equal(marker.textContent, "1m 59s left");
for (const urgencyClass of [
  "openfront-helper-ally-warning",
  "openfront-helper-ally-critical",
  "",
]) {
  timing.urgencyClass = urgencyClass;
  update();
  for (const element of [marker, line]) {
    for (const className of ["openfront-helper-ally-warning", "openfront-helper-ally-critical"]) {
      assert.equal(element.classList.contains(className), className === urgencyClass);
    }
  }
}

const replacementLine = createLine();
sandbox.updateAllyMarker(marker, replacementLine, timing, position, hovered);
assert.equal(replacementLine.getAttribute("x1"), "30", "new line nodes get fresh render state");
assert.equal(replacementLine.getAttribute("x2"), "130");
const replacementMarker = createMarker();
sandbox.updateAllyMarker(replacementMarker, replacementLine, timing, position, hovered);
assert.equal(replacementMarker.textContent, "1m 59s left");
assert.equal(replacementMarker.style.getPropertyValue("--ally-x"), "130px");

process.stdout.write("alliance marker performance tests passed\n");
