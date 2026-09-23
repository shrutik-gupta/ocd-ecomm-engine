const sharp = require('sharp');
(async () => {
  const meta = await sharp('/tmp/ref.jpg').metadata();
  console.log('format:', meta.format, '| space:', meta.space, '| channels:', meta.channels, '| hasProfile:', !!meta.icc, '| width:', meta.width, '| height:', meta.height);
  await sharp('/tmp/ref.jpg').rotate().flatten({ background: '#ffffff' }).toColorspace('srgb').png().toFile('/tmp/ref_clean.png');
  console.log('wrote /tmp/ref_clean.png');
})();
