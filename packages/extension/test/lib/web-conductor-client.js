import { a as l, C as u, R as d, W as w, d as y, l as C, t as h } from "./WebConductorAppClient-Cd2L0eOd.js";
import { GatewayError as m, GatewayProxy as x, JoinSession as b, JoiningClient as f, JoiningError as A } from "@holo-host/joining-service/client";
import { CellType as g, SignalType as E } from "@holochain/client";
function i(o = 5e3) {
  return new Promise((e, t) => {
    var n;
    if ((n = window.holochain) != null && n.isWebConductor) {
      e();
      return;
    }
    const r = setTimeout(() => {
      t(
        new Error("Holochain extension not detected. Please install the Holochain browser extension.")
      );
    }, o);
    window.addEventListener(
      "holochain:ready",
      () => {
        clearTimeout(r), e();
      },
      { once: !0 }
    );
  });
}
function a() {
  var o;
  return ((o = window.holochain) == null ? void 0 : o.isWebConductor) === !0;
}
export {
  g as CellType,
  l as ConnectionMonitor,
  u as ConnectionStatus,
  m as GatewayError,
  x as GatewayProxy,
  b as JoinSession,
  f as JoiningClient,
  A as JoiningError,
  d as ReconnectionManager,
  E as SignalType,
  w as WebConductorAppClient,
  y as deepConvertByteArrays,
  a as isWebConductorAvailable,
  C as looksLikeByteArray,
  h as toUint8Array,
  i as waitForHolochain
};
//# sourceMappingURL=index.js.map
