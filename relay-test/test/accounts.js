// Shared check: everything in the request is either shown to the model verbatim or counted in a visible marker.
import { evidenceClass } from '../src/prompt.js';
export function fitAccounts(req, fit) {
  const brief = fit.messages[1].content, om = fit.omitted;
  // protected material always present
  for (const e of req.evidence) if (['hard', 'now', 'marker'].includes(evidenceClass(e)) && !brief.includes(e)) return false;
  for (const t of req.targets) if (!brief.includes(t)) return false;
  for (const o of req.options) if (!brief.includes(`- ${o} = `)) return false;
  if (req.detail && !brief.includes(req.detail)) return false;
  // every evidence line is either shown verbatim or counted in a visible marker
  const shown = req.evidence.filter(e => brief.includes('- ' + e)).length;
  const counted = (om.public || 0) + (om.sightings || 0) + (om.votes || 0) + (om.other || 0);
  if (shown + counted !== req.evidence.length) return false;
  for (const [k, w] of [['public', 'older public notes'], ['sightings', 'older sightings'], ['votes', 'older records of your votes'], ['other', 'older notes']])
    if (!!om[k] !== brief.includes(`(${om[k]} ${w} omitted to fit)`)) return false;
  if (req.phase !== 'play') {
    const shownChat = req.chat.filter(c => brief.includes(`- ${c.speaker}: ${c.text}`)).length;
    const shortened = (brief.match(/^- .* …\[shortened\]$/gm) || []).length; // chat lines only (the header also names the marker)
    if (shortened !== (om.shortened || 0)) return false;
    if (shownChat + shortened + (om.chat || 0) !== req.chat.length) return false;
    if (!!om.chat !== /older messages omitted to fit/.test(brief)) return false;
    if (req.chat.length && !brief.includes(req.chat[req.chat.length - 1].text)) return false; // newest message always intact
  }
  return true;
}
