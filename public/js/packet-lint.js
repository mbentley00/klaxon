// Checks a parsed packet for the damage a .docx -> JSON conversion leaves
// behind. YAPP either parses a packet or refuses it, so the failures that
// actually reach a reader are the quiet ones: a numbered question that never
// came through, two tossups merged into one, a bonus that lost a part, a power
// marker that didn't survive the round trip. Those show up as a packet that
// looks fine until someone reads it out loud in a room.
//
// Every threshold here was set against ~700 real packets from the hsquizbowl
// archive (1998-2026), so a "warning" means the packet is unusual against that
// corpus, not merely against one house style. The numbers each check leans on
// are noted where they're used.
//
// Pure and dependency-free on purpose: the /yapp page runs it in the browser on
// the JSON it just got back, and the server can run the same code on an
// uploaded packet.

// --- text helpers ------------------------------------------------------------
// Packet text is HTML: YAPP marks the required part of an answer with <b><u>,
// and questions carry <em>/<b> from the original document. Lengths and word
// counts have to be measured on what a reader would actually say, so tags come
// off first.
const TAG = /<[^>]*>/g;
const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export function plain(html) {
  return String(html ?? '')
    .replace(TAG, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY[m])
    .replace(/\s+/g, ' ')
    .trim();
}

const median = (nums) => {
  if (!nums.length) return 0;
  const v = [...nums].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

// The value that appears most often, with ties broken toward the larger one —
// a packet's "house style" for things like bonus part counts.
function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
  }
  return { value: best, count: bestN, total: values.length };
}

// "1, 4 and 17" — question numbers read better than a bare list.
function listNumbers(ns, max = 12) {
  const shown = ns.slice(0, max).join(', ');
  return ns.length > max ? `${shown} and ${ns.length - max} more` : shown;
}

// --- thresholds --------------------------------------------------------------
// Corpus figures these come from (n = 14,321 tossups in 710 packets):
//   tossup length   p1 450, p50 788, p99 1068  -> under 400 is the bottom 0.6%
//   (*) position    p1 .35, p50 .55, p99 .74   -> outside .15-.85 is off the map
//   guide [..] span p50 10 chars, p95 22, p99 39 -> 60+ is a guide that ran away
//   bonus values    12,723 of 12,755 sum to 30
const SHORT_TOSSUP = 400;
const SHORT_TOSSUP_RATIO = 0.55;    // ...and this much below the packet's own median
const LONG_TOSSUP_RATIO = 1.7;      // a question ~twice the rest is usually two questions
const MERGED_TOSSUP_RATIO = 1.35;   // ...and this much, plus a stray question number, proves it
const LONG_ANSWER = 700;            // p99 of real answer lines is 513; 700 is the top 1% of packets
const LONG_LEADIN = 400;
const POWER_MIN_POS = 0.15;
const POWER_MAX_POS = 0.85;
const GUIDE_MAX_CHARS = 60;
const GUIDE_MAX_WORDS = 8;
const STYLE_MAJORITY = 0.6;         // how much of a packet must share a habit before an exception is odd

const POWER = /\(\*\)/g;
// A bracketed aside that is a note TO the moderator, not a pronunciation guide.
// These are legitimately long ("Note to reader: read the answer line first"),
// so they're exempt from the runaway-guide check.
const MOD_NOTE = /^\s*(?:<[^>]*>\s*)*(?:note|mod note|moderator|read|emphasize|pause|slow|do not|don'?t|players?)\b/i;
// An answer alternative rather than a guide: "[or Roma; accept Roman Republic]".
// These belong on answer lines, but they turn up mid-question too, and they run
// long by design.
const ANSWER_ASIDE = /^\s*(?:<[^>]*>\s*)*(?:or|accept|prompt|reject|anti-?prompt|do not accept)\b/i;
// The sentence every tossup ends on, with the clause that follows it. Finding
// this on an ANSWER line means the parser never saw the boundary and read on
// into the next question. The prompt alone won't do: "accept acetylenes before
// FTP" is a real instruction on a real answer line.
const QUESTION_PROSE = /for (?:10|ten|15|fifteen) points,\s+(?:name|identify|give|what|which)\b/i;
// Mojibake from a document that was decoded as the wrong code page, plus the
// replacement character an undecodable byte leaves behind.
const MOJIBAKE = /�|Â[\s ]|â€[™œ]|Ã[©¨¤¶ ]/;

// --- one finding -------------------------------------------------------------
// level: 'error'   the packet will read wrong -- fix before a round uses it
//        'warning' almost certainly damage, but a reader could work around it
//        'note'    unusual; worth a glance, often deliberate
const finding = (level, code, message, where = '') => ({ level, code, message, where });

// --- the checks --------------------------------------------------------------

// Counts first: a packet that lost a whole question is the failure that hurts
// most, and it shows up as an imbalance rather than as anything wrong on a page.
function checkCounts(tossups, bonuses, out) {
  if (!tossups.length) {
    out.push(finding('error', 'no-tossups', 'No tossups came out of this packet at all.'));
    return;
  }
  if (!bonuses.length) {
    out.push(finding('note', 'no-bonuses',
      `${tossups.length} tossups and no bonuses. Fine for a tossup-only packet — check it isn't a bonus round that failed to parse.`));
    return;
  }
  const diff = tossups.length - bonuses.length;
  // One spare tossup is the usual tiebreaker and shows up in 39 of 576 balanced
  // packets in the corpus; two or more is a question that went missing.
  if (diff >= 2) {
    out.push(finding('warning', 'count-mismatch',
      `${tossups.length} tossups but only ${bonuses.length} bonuses — ${diff} bonuses may have been lost in the conversion.`));
  } else if (diff < 0) {
    out.push(finding('warning', 'count-mismatch',
      `${bonuses.length} bonuses but only ${tossups.length} tossups — ${-diff} tossup${diff === -1 ? '' : 's'} may have been lost in the conversion.`));
  }
}

function checkTossups(tossups, out) {
  const lengths = tossups.map((t) => plain(t.question).length);
  const mid = median(lengths.filter((n) => n > 0));

  // Does this packet mark powers, mark up its answer lines, carry categories?
  // Each check below only fires for a question that breaks its own packet's
  // habit, so a 1998 packet with no powers anywhere stays quiet.
  const powerCounts = tossups.map((t) => ((t.question ?? '').match(POWER) || []).length);
  const powered = powerCounts.filter((n) => n > 0).length;
  const usesPowers = powered >= tossups.length * STYLE_MAJORITY;
  const marked = tossups.filter((t) => /<u>|<b>/i.test(t.answer ?? '')).length;
  const marksAnswers = marked >= tossups.length * STYLE_MAJORITY;
  const tagged = tossups.filter((t) => plain(t.metadata).length > 0).length;
  const usesMetadata = tagged >= tossups.length * STYLE_MAJORITY;

  const missingPower = [];
  const missingMeta = [];
  const unmarkedAnswer = [];
  const short = [];
  const long = [];

  tossups.forEach((t, i) => {
    const n = i + 1;
    const q = plain(t.question);
    const a = plain(t.answer);
    const at = `tossup ${n}`;

    if (!q) out.push(finding('error', 'empty-question', 'This tossup has no question text.', at));
    if (!a) out.push(finding('error', 'empty-answer', 'This tossup has no answer line.', at));
    if (!q || !a) return;

    // Length, relative to this packet rather than to an absolute house style:
    // a short question usually means the parser stopped early, a long one that
    // it ran two questions together after losing a number.
    if (q.length < SHORT_TOSSUP && (!mid || q.length < mid * SHORT_TOSSUP_RATIO)) short.push(n);
    if (mid && q.length > mid * LONG_TOSSUP_RATIO) long.push(n);

    // The clincher for a merged pair: the NEXT question's number, still sitting
    // mid-sentence in this one. YAPP strips the number it recognises, so one
    // left behind is a number it read as prose after losing the question break.
    // Only checked on a question already running long, which is what keeps
    // "Piano Sonata No. 17. One of these..." out of the results.
    if (mid && q.length > mid * MERGED_TOSSUP_RATIO) {
      const nextNumber = new RegExp('[.?!\u201d"\']\\s+' + (n + 1) + '\\.\\s+[A-Z\u201c"]');
      if (nextNumber.test(q.slice(40))) {
        out.push(finding('error', 'merged-tossups',
          `Tossup ${n + 1}'s number appears in the middle of this question, which is also far longer than the rest of the packet — two tossups have been run together into one.`, at));
      }
    }

    // An answer line is a list of answers. Question prose in one means the
    // parser never found the boundary and read on into the next question.
    if (QUESTION_PROSE.test(a)) {
      out.push(finding('error', 'answer-runs-on',
        'The answer line contains question text ("for 10 points…"), so it has run into the question after it.', at));
    }
    if (a.length > LONG_ANSWER) {
      out.push(finding('note', 'long-answer',
        `The answer line runs ${a.length} characters. Usually that is just a long list of acceptable answers — check it hasn't run into the next question.`, at));
    }

    // Powers.
    const stars = powerCounts[i];
    if (usesPowers && stars === 0) missingPower.push(n);
    if (stars > 1) {
      out.push(finding('warning', 'extra-power', `${stars} power markers in one tossup.`, at));
    }
    if (stars === 1 && q.length > 200) {
      const at01 = q.indexOf('(*)') / q.length;
      if (at01 < POWER_MIN_POS || at01 > POWER_MAX_POS) {
        out.push(finding('warning', 'power-position',
          `The power marker sits ${Math.round(at01 * 100)}% of the way into the question. In real packets it almost never falls before 35% or after 75%, so this one is probably in the wrong place.`, at));
      }
    }

    if (marksAnswers && !/<u>|<b>/i.test(t.answer ?? '')) unmarkedAnswer.push(n);
    if (usesMetadata && !plain(t.metadata)) missingMeta.push(n);

    checkText(q, at, out);
    checkText(a, `${at} answer line`, out, { guides: false });
  });

  if (missingPower.length) {
    out.push(finding('warning', 'missing-power',
      `${powered} of ${tossups.length} tossups have a (*) power marker, but ${missingPower.length === 1 ? 'this one does' : 'these do'} not: ${listNumbers(missingPower)}.`,
      missingPower.length === 1 ? `tossup ${missingPower[0]}` : ''));
  }
  if (unmarkedAnswer.length) {
    out.push(finding('warning', 'unmarked-answer',
      `The required part of the answer is underlined everywhere except ${unmarkedAnswer.length === 1 ? 'tossup' : 'tossups'} ${listNumbers(unmarkedAnswer)}.`));
  }
  if (short.length) {
    out.push(finding('warning', 'short-tossup',
      `Unusually short next to the rest of the packet (median ${Math.round(mid)} characters): ${short.length === 1 ? 'tossup' : 'tossups'} ${listNumbers(short)}. A question that stops early usually means the parser lost the end of it.`));
  }
  if (long.length) {
    out.push(finding('warning', 'long-tossup',
      `Much longer than the rest of the packet (median ${Math.round(mid)} characters): ${long.length === 1 ? 'tossup' : 'tossups'} ${listNumbers(long)}. Two questions run together look like this.`));
  }
  if (missingMeta.length) {
    out.push(finding('note', 'missing-metadata',
      `Every other tossup carries a category line; ${missingMeta.length === 1 ? 'tossup' : 'tossups'} ${listNumbers(missingMeta)} ${missingMeta.length === 1 ? 'does' : 'do'} not.`));
  }

  return { usesPowers, usesMetadata, powered };
}

function checkBonuses(bonuses, out) {
  if (!bonuses.length) return {};
  const partCounts = bonuses.map((b) => (b.parts || []).length);
  const usual = mode(partCounts);
  const sums = bonuses.map((b) => (b.values || []).reduce((a, v) => a + (Number(v) || 0), 0));
  const usualSum = mode(sums);

  const oddParts = [];
  const oddValues = [];
  bonuses.forEach((b, i) => {
    const n = i + 1;
    const at = `bonus ${n}`;
    const parts = b.parts || [];
    const answers = b.answers || [];
    const values = b.values || [];

    // A reader can't score a bonus whose three arrays disagree, so this one is
    // an error rather than a warning.
    if (parts.length !== answers.length || parts.length !== values.length) {
      out.push(finding('error', 'bonus-shape',
        `${parts.length} parts, ${answers.length} answers and ${values.length} values — they have to match.`, at));
      return;
    }
    if (!plain(b.leadin)) {
      out.push(finding('error', 'empty-leadin', 'This bonus has no leadin.', at));
    } else if (plain(b.leadin).length > LONG_LEADIN) {
      out.push(finding('warning', 'long-leadin',
        `The leadin runs ${plain(b.leadin).length} characters — it may have absorbed the previous question.`, at));
    }
    parts.forEach((p, j) => {
      if (!plain(p)) out.push(finding('error', 'empty-part', `Part ${j + 1} has no text.`, at));
      if (!plain(answers[j])) out.push(finding('error', 'empty-part-answer', `Part ${j + 1} has no answer.`, at));
    });

    // 12,724 of 12,755 corpus bonuses are three parts worth 10 each; a bonus
    // that isn't usually lost a part on the way through.
    const partsAreOdd = usual.count >= bonuses.length * STYLE_MAJORITY && parts.length !== usual.value;
    if (partsAreOdd) oddParts.push(n);
    // Only worth saying when the parts are right: a bonus that lost a part is
    // also short 10 points, and one finding covers it.
    if (!partsAreOdd && usualSum.count >= bonuses.length * STYLE_MAJORITY && sums[i] !== usualSum.value) oddValues.push(n);

    checkText(plain(b.leadin), `${at} leadin`, out);
  });

  if (oddParts.length) {
    out.push(finding('warning', 'bonus-parts',
      `This packet's bonuses are ${usual.value} parts each, but ${oddParts.length === 1 ? 'bonus' : 'bonuses'} ${listNumbers(oddParts)} ${oddParts.length === 1 ? 'is' : 'are'} not — a part probably didn't survive the conversion.`));
  }
  if (oddValues.length) {
    out.push(finding('warning', 'bonus-values',
      `Bonuses here are worth ${usualSum.value} points, but ${oddValues.length === 1 ? 'bonus' : 'bonuses'} ${listNumbers(oddValues)} ${oddValues.length === 1 ? 'is' : 'are'} not.`));
  }
  return { usualParts: usual.value };
}

// Checks that apply to any run of packet text: brackets that never close,
// pronunciation guides that ran away with the sentence, and the tell-tale
// characters of a document decoded as the wrong code page.
//
// `guides` is off for answer lines. Square brackets mean something different
// there — they hold the acceptable and promptable answers, and those run long
// on purpose ("[or ovum; or ova; or oocytes; ...]").
function checkText(text, at, out, { guides = true } = {}) {
  if (!text) return;

  // A pronunciation guide is a few words. When one is long, the closing bracket
  // was lost and it has eaten the rest of the sentence — which a moderator will
  // then read out as a pronunciation. Notes to the moderator and the answer
  // alternatives that sometimes appear mid-question are legitimately long, so
  // they're left alone.
  if (guides) {
    for (const m of text.matchAll(/\[([^\[\]]{1,600})\]/g)) {
      const span = m[1];
      if (MOD_NOTE.test(span) || ANSWER_ASIDE.test(span)) continue;
      if (span.length > GUIDE_MAX_CHARS || span.split(/\s+/).length > GUIDE_MAX_WORDS) {
        out.push(finding('warning', 'long-guide',
          `A ${span.length}-character pronunciation guide: “${span.slice(0, 70)}${span.length > 70 ? '…' : ''}”. Guides are a couple of words; this one has probably swallowed the text after it.`, at));
      }
    }
  }

  const opens = (text.match(/\[/g) || []).length;
  const closes = (text.match(/\]/g) || []).length;
  if (opens !== closes) {
    out.push(finding('warning', 'unbalanced-brackets',
      `${opens} “[” and ${closes} “]” — a pronunciation guide or answer alternative isn't closed.`, at));
  }

  if (MOJIBAKE.test(text)) {
    out.push(finding('warning', 'mojibake',
      'Garbled characters — the document was saved in an encoding the parser had to guess at. Check the accents and quotation marks.', at));
  }
}

// The numbers the parser read off the page, which is the most direct evidence
// there is that a question went missing: if the document numbers a tossup 4 and
// no tossup 4 came out, the conversion dropped it. Every packet in the corpus
// carries these, and only 4 of 685 have a gap -- each a real one.
//
// A packet whose tossups aren't all numbered (a reader's own JSON, say, rather
// than something the parser produced) is skipped rather than guessed at.
function checkNumbering(tossups, out) {
  const numbers = tossups.map((t) => t.number);
  if (!numbers.every((n) => Number.isInteger(n))) return;

  const missing = [];
  const repeated = [];
  const backwards = [];
  const seen = new Set();
  numbers.forEach((n, i) => {
    if (seen.has(n)) repeated.push(n);
    seen.add(n);
    if (i === 0) return;
    const prev = numbers[i - 1];
    if (n <= prev) backwards.push(`${prev} then ${n}`);
    else for (let gap = prev + 1; gap < n; gap++) missing.push(gap);
  });

  if (missing.length) {
    out.push(finding('error', 'missing-question',
      `The document numbers ${missing.length === 1 ? 'a tossup' : 'tossups'} ${listNumbers(missing)}, but ${missing.length === 1 ? "it isn't" : 'they are not'} in the parsed packet — ${missing.length === 1 ? 'that question' : 'those questions'} did not make it through the conversion.`));
  }
  if (repeated.length) {
    out.push(finding('warning', 'repeated-number',
      `Tossup number${repeated.length === 1 ? '' : 's'} ${listNumbers([...new Set(repeated)])} appear${repeated.length === 1 ? 's' : ''} more than once.`));
  }
  if (backwards.length) {
    out.push(finding('warning', 'numbering-order',
      `The tossup numbers go backwards (${backwards.slice(0, 3).join(', ')}) — the questions may be out of order.`));
  }
}

// Two tossups with the same opening are either a genuine repeat in the source
// or a parser that emitted one twice; both need a human to look.
function checkDuplicates(tossups, out) {
  const seen = new Map();
  tossups.forEach((t, i) => {
    const key = plain(t.question).slice(0, 120).toLowerCase();
    if (key.length < 60) return;
    if (seen.has(key)) {
      out.push(finding('warning', 'duplicate-question',
        `Tossups ${seen.get(key) + 1} and ${i + 1} start with the same text.`, `tossup ${i + 1}`));
    } else {
      seen.set(key, i);
    }
  });
}

// --- entry point -------------------------------------------------------------
/**
 * Lints one parsed packet. Returns findings ordered error -> warning -> note,
 * plus a summary the caller can show even when nothing is wrong.
 */
export function lintPacket(packet, { name = '' } = {}) {
  const out = [];
  if (!packet || typeof packet !== 'object' || !Array.isArray(packet.tossups)) {
    return {
      name,
      findings: [finding('error', 'not-a-packet', 'This isn\'t a packet: there is no list of tossups in it.')],
      summary: { tossups: 0, bonuses: 0 }
    };
  }
  const tossups = packet.tossups.filter((t) => t && typeof t === 'object');
  const bonuses = (Array.isArray(packet.bonuses) ? packet.bonuses : []).filter((b) => b && typeof b === 'object');

  checkCounts(tossups, bonuses, out);
  checkNumbering(tossups, out);
  const tu = tossups.length ? checkTossups(tossups, out) : {};
  const bn = checkBonuses(bonuses, out);
  checkDuplicates(tossups, out);

  const rank = { error: 0, warning: 1, note: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);

  return {
    name: name || packet.name || '',
    findings: out,
    summary: {
      tossups: tossups.length,
      bonuses: bonuses.length,
      powered: !!tu.usesPowers,
      categories: !!tu.usesMetadata,
      bonusParts: bn.usualParts ?? null,
      errors: out.filter((f) => f.level === 'error').length,
      warnings: out.filter((f) => f.level === 'warning').length,
      notes: out.filter((f) => f.level === 'note').length
    }
  };
}

/**
 * Lints a whole set at once. Each packet gets its own findings, and the set as a
 * whole gets the check a single packet can't do: a packet that is a question
 * short only looks wrong next to the other twenty-three from the same set.
 */
export function lintSet(packets) {
  const reports = packets.map(({ name, packet }) => lintPacket(packet, { name }));
  const sound = reports.filter((r) => r.summary.tossups > 0);
  if (sound.length >= 3) {
    const usual = mode(sound.map((r) => r.summary.tossups));
    if (usual.count >= sound.length * STYLE_MAJORITY) {
      for (const r of reports) {
        const n = r.summary.tossups;
        if (n > 0 && n !== usual.value) {
          r.findings.unshift(finding('warning', 'set-count-outlier',
            `${n} tossups, where every other packet in this set has ${usual.value}. ${n < usual.value ? `${usual.value - n} question${usual.value - n === 1 ? '' : 's'} probably didn't make it through.` : 'Check for a question that got counted twice.'}`));
        }
      }
    }
  }
  return reports;
}
