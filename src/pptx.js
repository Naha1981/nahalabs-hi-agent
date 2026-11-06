// Genuine PPTX slide decks (Office Open XML PresentationML) via pptxgenjs.
// The agent supplies a JSON outline: {"title":"...","slides":[{"heading":"...","bullets":["..."]}]}.
// Only the supplied text is used - no invented stats, no platform branding.
import PptxGenJS from 'pptxgenjs';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Accepts {"title":"...","slides":[{"heading":"...","bullets":["..."]}]}.
export function deckJson(content) {
  let v;
  try { v = JSON.parse(content); } catch { return { error: 'pptx content must be JSON: {"title":"My deck","slides":[{"heading":"Slide 1","bullets":["point one","point two"]}]}' }; }
  const slides = Array.isArray(v?.slides) ? v.slides : null;
  if (!slides || !slides.length) return { error: 'a deck needs at least one slide.' };
  if (slides.length > 20) return { error: 'a deck is limited to 20 slides.' };
  const out = [];
  for (const s of slides) {
    const heading = clean(s?.heading, 120);
    const bullets = (Array.isArray(s?.bullets) ? s.bullets : []).map((b) => clean(b, 240)).filter(Boolean).slice(0, 8);
    if (!heading && !bullets.length) return { error: 'every slide needs a heading or at least one bullet.' };
    out.push({ heading, bullets });
  }
  return { deck: { title: clean(v.title, 120) || 'Deck', slides: out } };
}

export async function buildPptx({ title, slides }) {
  const p = new PptxGenJS();
  p.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  p.layout = 'WIDE';
  p.title = title;
  const titleSlide = p.addSlide();
  titleSlide.addText(title, { x: 0.8, y: 2.9, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: '18181B', align: 'center', fontFace: 'Arial' });
  for (const s of slides) {
    const slide = p.addSlide();
    if (s.heading) slide.addText(s.heading, { x: 0.8, y: 0.5, w: 11.7, h: 1.0, fontSize: 28, bold: true, color: '18181B', fontFace: 'Arial' });
    if (s.bullets.length) {
      slide.addText(s.bullets.map((t) => ({ text: t, options: { bullet: { code: '2022' }, breakLine: true, paraSpaceAfter: 10 } })), { x: 1.0, y: 1.7, w: 11.3, h: 5.2, fontSize: 18, color: '3F3F46', fontFace: 'Arial', valign: 'top' });
    }
  }
  return Buffer.from(await p.write({ outputType: 'nodebuffer' }));
}
