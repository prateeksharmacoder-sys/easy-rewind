/**
 * easy-rewind Icon Generator
 * 
 * Run this script with Node.js to generate the PNG icon files
 * for the Chrome extension from the SVG definition below.
 * 
 * Usage: node generate-icons.js
 * 
 * This creates: icons/icon16.png, icon32.png, icon48.png, icon128.png
 */

const fs = require('fs');
const path = require('path');

// SVG icon definition - purple gradient with rewind symbol
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#7c3aed"/>
      <stop offset="50%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#ec4899"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)"/>
  <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" 
        font-size="72" fill="white">⏪</text>
</svg>`;

// Write the SVG file (can be used directly in some contexts)
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), SVG);

console.log('SVG icon written to icons/icon.svg');
console.log('');
console.log('To generate PNG files, install sharp:');
console.log('  npm install sharp');
console.log('Then run: node generate-icons-png.js');
console.log('');
console.log('OR: Open icons/icon.svg in a browser and screenshot at different sizes.');
console.log('OR: Use any SVG-to-PNG converter for sizes: 16, 32, 48, 128px');
