const canvas = document.getElementById('frame');
const context = canvas.getContext('2d', { alpha: false });

window.renderAbsoluteFrame = (frameIndex) => {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error('absolute frame index required');
  context.fillStyle = `rgb(${(frameIndex * 53 + 17) % 256}, ${(frameIndex * 97 + 31) % 256}, ${(frameIndex * 193 + 47) % 256})`;
  context.fillRect(0, 0, 96, 64);
  context.fillStyle = `rgb(${255 - frameIndex * 17}, ${32 + frameIndex * 23}, ${64 + frameIndex * 29})`;
  context.fillRect(frameIndex * 7 + 5, frameIndex * 5 + 7, 24, 18);
  context.fillStyle = '#ffffff';
  for (let bit = 0; bit < 8; bit += 1) {
    if ((frameIndex >> bit) & 1) context.fillRect(70 + bit * 2, 48, 1, 8);
  }
  return { frameIndex, width: canvas.width, height: canvas.height };
};
