declare module '@holo-host/identicon' {
  interface IdenticonOpts {
    hash: Uint8Array;
    size?: number;
  }
  export default function renderIdenticon(opts: IdenticonOpts, canvas: HTMLCanvasElement): void;
}
