const fs = require('fs');
const path = require('path');
const file = path.join(process.cwd(), 'ui', 'index.html');
if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
let html = fs.readFileSync(file, 'utf8');
const backup = `${file}.before-move-behavior-guide.bak`;
fs.copyFileSync(file, backup);
const guideStart = html.indexOf('<div id="behaviorGuide"');
if (guideStart < 0) throw new Error('Behavior Guide was not found.');
function findDivEnd(text, start) {
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('</')) depth--; else depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}
const guideEnd = findDivEnd(html, guideStart);
if (guideEnd < 0) throw new Error('Could not parse Behavior Guide block.');
const guide = html.slice(guideStart, guideEnd);
html = html.slice(0, guideStart) + html.slice(guideEnd);
const asideClose = html.indexOf('</aside>');
if (asideClose < 0) throw new Error('Right column </aside> was not found.');
html = html.slice(0, asideClose) + '\n' + guide + '\n' + html.slice(asideClose);
html = html.replace(/v2\.3\.0/g, 'v2.3.1');
fs.writeFileSync(file, html, 'utf8');
console.log('Behavior Guide moved to the right column successfully.');
console.log(`Backup: ${backup}`);
