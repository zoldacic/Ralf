'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const log = require('../util/logger');

const PAGE = { size: 'A4', margin: 56 };
const RULE = '#b9a68a';
const INK = '#2b2620';
const FADED = '#6b6156';

/**
 * The recap is markdown written for Discord — headings, bullets, bold. Parse it
 * into blocks rather than rendering the asterisks literally into a printed page.
 */
function parseBlocks(markdown) {
  const blocks = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1] });
      continue;
    }
    // A line that is nothing but bold is a heading in all but syntax, and the
    // summary prompt asks for "short headings" without insisting on hashes.
    const boldOnly = line.match(/^\*\*(.+)\*\*:?\s*$/);
    if (boldOnly) {
      blocks.push({ type: 'heading', level: 2, text: boldOnly[1] });
      continue;
    }
    blocks.push({ type: 'para', text: line.trim() });
  }
  return blocks;
}

/** Strip inline markdown; pdfkit's standard fonts have no bold-italic dance here. */
function plain(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)\*(.+?)\*(?=\W|$)/g, '$1$2')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

/**
 * Space left on the current page. Used to decide whether the next picture fits
 * or should start the next page, so captions never orphan from their image.
 */
function remaining(doc) {
  return doc.page.height - doc.page.margins.bottom - doc.y;
}

function drawImage(doc, image, width) {
  const caption = plain(image.caption || '');
  // 512x512 renders, so height tracks width; leave room for the caption.
  const needed = width + (caption ? 26 : 0) + 18;
  if (remaining(doc) < needed) doc.addPage();

  const x = (doc.page.width - width) / 2;
  try {
    doc.image(image.file, x, doc.y, { width });
  } catch (err) {
    log.warn(`Could not place ${path.basename(image.file)} in the PDF: ${err.message}`);
    return;
  }
  doc.y += width + 8;

  if (caption) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(FADED);
    doc.text(caption, doc.page.margins.left, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
    });
  }
  doc.moveDown(1);
}

/**
 * Build the illustrated recap.
 *
 * Images are spread through the text rather than dumped at the end: the scenes
 * come back in the order they happened, so they are interleaved at even
 * intervals between blocks and end up roughly beside the events they show.
 *
 * @param {object} opts
 * @param {string} opts.summary   recap markdown
 * @param {Array<{caption:string,file:string}>} [opts.images]
 * @param {string} opts.file      destination path
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @returns {Promise<string>} the written path
 */
function buildPdf({ summary, images = [], file, title = 'Session recap', subtitle = '' }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const doc = new PDFDocument({ ...PAGE, info: { Title: title, Author: 'Ralf' } });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    stream.on('error', reject);
    stream.on('finish', () => resolve(file));

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(24).fillColor(INK).text(title);
    if (subtitle) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor(FADED).text(subtitle);
    }
    doc.moveDown(0.6);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(RULE)
      .lineWidth(1)
      .stroke();
    doc.moveDown(1);

    const blocks = parseBlocks(summary);
    // Place the first picture under the opening paragraph, then space the rest
    // evenly through what remains.
    const every = images.length ? Math.max(1, Math.floor(blocks.length / images.length)) : 0;
    let next = 0;

    blocks.forEach((b, i) => {
      switch (b.type) {
        case 'heading':
          if (doc.y > doc.page.margins.top) doc.moveDown(0.8);
          doc
            .font('Helvetica-Bold')
            .fontSize(b.level <= 2 ? 14 : 12)
            .fillColor(INK)
            .text(plain(b.text), { width });
          doc.moveDown(0.4);
          break;
        case 'bullet':
          doc.font('Helvetica').fontSize(11).fillColor(INK);
          doc.text(`•  ${plain(b.text)}`, {
            width: width - 12,
            indent: 12,
            paragraphGap: 4,
          });
          break;
        default:
          doc.font('Helvetica').fontSize(11).fillColor(INK);
          doc.text(plain(b.text), { width, align: 'left', paragraphGap: 6 });
      }

      if (next < images.length && every && (i + 1) % every === 0) {
        doc.moveDown(0.6);
        drawImage(doc, images[next++], Math.min(width, 380));
      }
    });

    // Anything that didn't fit the interleaving still belongs in the document.
    while (next < images.length) {
      doc.moveDown(0.6);
      drawImage(doc, images[next++], Math.min(width, 380));
    }

    doc.end();
  });
}

module.exports = { buildPdf, parseBlocks, plain };
