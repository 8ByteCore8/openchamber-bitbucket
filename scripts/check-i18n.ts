// Every locale must use exactly the {placeholders} of the English string,
// key by key. tsc already checks that the keys match.
import en from '../src/i18n/en.ts';
import { DICTIONARIES } from '../src/i18n/index.ts';

const tokens = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
let failures = 0;
for (const [tag, messages] of Object.entries(DICTIONARIES)) {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const text = messages[key];
    if (typeof text !== 'string' || !text.trim()) {
      console.error(`${tag}.${key}: missing`);
      failures++;
    } else if (tokens(text) !== tokens(en[key])) {
      console.error(`${tag}.${key}: placeholders {${tokens(text)}} differ from en {${tokens(en[key])}}`);
      failures++;
    }
  }
}
if (failures) {
  console.error(`${failures} problem(s) in translations`);
  process.exit(1);
}
console.log(`Translations OK: ${Object.keys(DICTIONARIES).length} locales, ${Object.keys(en).length} keys`);
