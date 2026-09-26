import { decodeWire, toWire } from "@arena/sdk";

export async function wsConnect(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    frames.push(decodeWire(String(e.data)));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
    ws.addEventListener("close", () => rej(new Error("ws closed before open")));
  });
  const next = async (pred: (f: any) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("no matching frame");
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const hello = await next((f) => f.type === "hello");
  return {
    ws,
    nonce: hello.nonce as `0x${string}`,
    send: (f: unknown) => ws.send(toWire(f)),
    next,
    frames,
    closed: new Promise((r) => ws.addEventListener("close", r)),
  };
}
