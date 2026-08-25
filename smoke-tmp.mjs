import * as meta from '../src/meta.js';
const sets = await meta.listAdSets();
const live = sets.filter(s => s.status === 'ACTIVE');
console.log('ACTIVE ad sets:');
for (const s of live) console.log(`  ${s.id}  ${s.name}  (campaign: ${s.campaign?.name})`);
