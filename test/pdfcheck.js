/* Strict-ish validation of the generated PDF: xref offsets must point at "N 0 obj". */
const fs = require('fs');
const path = require('path');
const files = fs.readdirSync(__dirname).filter(f => f.startsWith('sample_') && f.endsWith('.pdf'));
let bad = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(__dirname, f));
  const text = buf.toString('latin1');
  const headerPos = text.lastIndexOf('xref\n0 ');
  const lines = text.slice(headerPos).split('\n');
  // lines[0]="xref", lines[1]="0 <count>", lines[2+i] = entry for object i
  const count = parseInt(lines[1].trim().split(' ')[1], 10);
  let okCount = 0;
  for (let i = 1; i < count; i++) {
    const off = parseInt(lines[2 + i].trim().split(' ')[0], 10);
    const at = text.slice(off, off + 12);
    if (at.startsWith(i + ' 0 obj')) okCount++;
    else { console.log(f + ': obj ' + i + ' offset mismatch: "' + at + '"'); bad++; }
  }
  const trailerOk = /\/Root 1 0 R/.test(text) && /%%EOF/.test(text.slice(-10));
  console.log(f + ': ' + okCount + '/' + (count - 1) + ' xref offsets valid, trailer ' + (trailerOk ? 'OK' : 'BAD') + ', ' + buf.length + ' bytes');
  if (okCount !== count - 1 || !trailerOk) bad++;
}
console.log(bad === 0 ? 'PDF STRUCTURE OK' : 'PDF STRUCTURE PROBLEMS: ' + bad);
process.exit(bad === 0 ? 0 : 1);
