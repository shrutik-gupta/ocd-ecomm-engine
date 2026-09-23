const axios = require('axios');
const fs = require('fs');
const url = process.argv[2];
(async () => {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true });
  console.log('status:', r.status, '| content-type:', r.headers['content-type'], '| bytes:', r.data.length);
  const buf = Buffer.from(r.data);
  console.log('first16hex:', buf.slice(0, 16).toString('hex'));
  fs.writeFileSync('/tmp/ref_auth.bin', buf);
  console.log('wrote /tmp/ref_auth.bin');
})();
