/**
 * Generate PNG icons for the Chrome extension from the generated image.
 * Run from the backend directory: node generate-icons.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const iconSrcPath = process.argv[2] || path.join(__dirname, '..', 'extension', 'icons', 'icon.svg');
const iconsDir = path.join(__dirname, '..', 'extension', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const sizes = [16, 32, 48, 128];

async function generateIcons(sourcePath) {
  console.log('Generating icons from:', sourcePath);

  for (const size of sizes) {
    const outputPath = path.join(iconsDir, `icon${size}.png`);
    await sharp(sourcePath).resize(size, size).png().toFile(outputPath);
    console.log(`✅ Generated icon${size}.png`);
  }

  console.log('\n✨ All icons generated in:', iconsDir);
}

generateIcons(iconSrcPath).catch(console.error);
