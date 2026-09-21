/**
 * Painted sky aircraft — airliners and jets.
 */

import * as THREE from 'three';

function configureSkySpriteTexture(texture: THREE.CanvasTexture): THREE.CanvasTexture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Bright airliner — reads against day and night sky. */
export function airplaneSkyTexture(): THREE.CanvasTexture {
  const width = 380;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return configureSkySpriteTexture(new THREE.CanvasTexture(canvas));
  }
  ctx.clearRect(0, 0, width, height);
  const cy = height * 0.5;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.beginPath();
  ctx.moveTo(width * 0.06, cy);
  ctx.lineTo(width * 0.2, cy - 20);
  ctx.lineTo(width * 0.8, cy - 16);
  ctx.lineTo(width * 0.94, cy);
  ctx.lineTo(width * 0.8, cy + 16);
  ctx.lineTo(width * 0.2, cy + 20);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(42, 198, 176, 0.65)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(186, 230, 253, 0.9)';
  ctx.fillRect(width * 0.36, cy - 6, width * 0.3, 12);

  ctx.fillStyle = 'rgba(14, 116, 144, 0.55)';
  for (const fx of [0.3, 0.4, 0.5, 0.6, 0.68]) {
    ctx.fillRect(width * fx, cy - 4, width * 0.035, 8);
  }

  return configureSkySpriteTexture(new THREE.CanvasTexture(canvas));
}

/** Bright fighter jet. */
export function jetSkyTexture(): THREE.CanvasTexture {
  const width = 340;
  const height = 118;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return configureSkySpriteTexture(new THREE.CanvasTexture(canvas));
  }
  ctx.clearRect(0, 0, width, height);
  const cy = height * 0.5;

  ctx.fillStyle = 'rgba(248, 250, 252, 0.98)';
  ctx.beginPath();
  ctx.moveTo(width * 0.04, cy + 2);
  ctx.lineTo(width * 0.36, cy - 24);
  ctx.lineTo(width * 0.9, cy - 2);
  ctx.lineTo(width * 0.96, cy + 8);
  ctx.lineTo(width * 0.4, cy + 22);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(42, 198, 176, 0.7)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.fillStyle = 'rgba(56, 189, 248, 0.75)';
  ctx.beginPath();
  ctx.ellipse(width * 0.54, cy - 2, width * 0.09, height * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();

  return configureSkySpriteTexture(new THREE.CanvasTexture(canvas));
}
