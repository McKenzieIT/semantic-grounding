import { readFileSync } from 'node:fs'
interface Row { t: string; d: string; k: string; s: string; x: string; l: number; r: string[]; f: string[] }
const { rows } = JSON.parse(readFileSync('./out/probe-data.json','utf8')) as { rows: Row[] }
const CAP = 24
const LAYER = /^_?(df|di|mi|od|arch|dim|dws|dwd|ads|ods|cbt\d?|test)$/i
const killedNow = (r: Row) => r.r.length > 0 || r.l > CAP || r.t.includes('/') || LAYER.test(r.t.trim())
const surv = rows.filter(r => !killedNow(r))
console.log(`survivors after 9 rules + cap + A + B: ${surv.length}\n`)

const probe = (name: string, test: (r: Row) => boolean) => {
  const hits = surv.filter(test)
  const distinct = [...new Set(hits.map(r => r.t))]
  const cjk = distinct.filter(t => /^[一-龥]{2,6}$/.test(t))
  console.log(`${name}: adds ${hits.length} kills, ${distinct.length} distinct`)
  console.log(`  sample: ${distinct.slice(0,10).map(t=>JSON.stringify(t)).join(', ')}`)
  console.log(`  pure-Chinese 2-6char risk: ${cjk.length}${cjk.length?' → '+cjk.map(x=>JSON.stringify(x)).join(', '):''}\n`)
}
probe("D: '+' as operator (composite-key notation)", r => r.t.includes('+'))
probe("E: arrow/tilde chars → ~ ⇒", r => /[→←⇒~～]/.test(r.t))
probe("F: candidate is a substring of its own definition id", r => {
  const id = r.d.toLowerCase().replace(/[._-]/g,'')
  const t = r.t.toLowerCase().replace(/[._-]/g,'')
  return t.length >= 6 && id.includes(t)
})
probe("F': same, but any length (shows the false-negative danger)", r => {
  const id = r.d.toLowerCase().replace(/[._-]/g,'')
  const t = r.t.toLowerCase().replace(/[._-]/g,'')
  return id.includes(t)
})
// T+1 reality check
console.log(`"T+1" occurrences in the whole candidate population: ${rows.filter(r=>/^t\s*\+\s*1$/i.test(r.t)).length}`)
console.log(`candidates containing '+': ${rows.filter(r=>r.t.includes('+')).length}`)
