import qrcode from './qrcode-generator.mjs';

const encoder = new TextEncoder();
const MAX_BYTES = 1024;
const CELL_SIZE = 8;
const QUIET_ZONE_MODULES = 4;

// The encoder's documented extension point; keep Unicode invitation links intact.
qrcode.stringToBytes = (text) => Array.from(encoder.encode(text));

/** Generate a self-contained, printable SVG locally. No invitation is uploaded. */
export function createQrSvg(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('An event invitation link is required to generate its QR code.');
  }
  if (encoder.encode(text).length > MAX_BYTES) {
    throw new RangeError('This invitation link is too long for the event QR code.');
  }
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  return code.createSvgTag({
    cellSize: CELL_SIZE,
    margin: CELL_SIZE * QUIET_ZONE_MODULES,
    scalable: true,
  }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
}
