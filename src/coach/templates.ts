// Deterministic coaching language. This is the voice the app uses when no LLM
// is configured, and the fallback for any field an LLM response leaves out.
// Tone: a calm human coach talking to a ~850 player. Engine numbers stay out.
import type { Color, Finding, MomentText, PlyRecord } from '../domain/types';
import { COLOR_NAME, PIECE_NAME, attackedEnemyPieces, isCheckMove, other, pieceAt, squareName, undevelopedMinors } from '../chess/board';

type F = Finding['facts'];

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const list = (v: unknown) => {
  const arr = Array.isArray(v) ? v.map(String) : [];
  if (arr.length <= 1) return arr[0] ?? '';
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
};

/** Best guess at what the player wanted from a move, from board facts only. */
export function guessIntent(p: PlyRecord): string {
  const piece = PIECE_NAME[p.piece];
  if (p.san.startsWith('O-O')) return 'getting your king to safety';
  if (p.captured) return `winning the ${PIECE_NAME[p.captured]} on ${p.to}`;
  const targets = attackedEnemyPieces(p.fenAfter, p.to).filter((t) => t.type !== 'p');
  if (isCheckMove(p.san)) return 'giving check to keep the initiative';
  if (targets.length) return `attacking the ${targets.map((t) => squareName(t.type, t.square)).join(' and ')}`;
  const homeRank = p.color === 'w' ? '1' : '8';
  if ((p.piece === 'n' || p.piece === 'b') && p.from[1] === homeRank) return `developing your ${piece}`;
  if (p.piece === 'p') return 'gaining space with a pawn';
  return `finding a better square for your ${piece}`;
}

export interface MomentTextInput {
  primary: Finding;
  all: Finding[];
  played: PlyRecord;
  reply?: PlyRecord;
  mover: Color;
  bestSan?: string;
  betterPly: PlyRecord;
}

export function momentTitle(f: Finding, played: PlyRecord): string {
  const mv = `${played.moveNumber}${played.color === 'w' ? '.' : '...'}${played.san}`;
  switch (f.category) {
    case 'premature_attack':
      return `${mv} — active, but what's the follow-up?`;
    case 'pointless_check':
      return `${mv} — a check that helped your opponent`;
    case 'inefficient_moves':
      return `${mv} — there and back again`;
    case 'tactical_blindness':
      return `${mv} — a chance to win material`;
    case 'blunder':
      return `${mv} — a piece left unprotected`;
    case 'missed_threat':
      return `${mv} — what was your opponent threatening?`;
    case 'calculation':
      return `${mv} — check the opponent's reply`;
    case 'early_queen':
      return `${mv} — the queen comes out early`;
    case 'missed_king_attack':
      return `${mv} — their king is still in the center`;
    case 'king_safety':
      return `${mv} — careful with your king's pawns`;
    case 'opened_vs_king':
      return `${mv} — good idea: open the center`;
    case 'punished_mistake':
      return `${mv} — you took what was offered`;
    default:
      return mv;
  }
}

export function buildMomentText(input: MomentTextInput): MomentText {
  const { primary: f, played, reply, mover, bestSan, betterPly } = input;
  const opp = COLOR_NAME[other(mover)];
  const facts: F = f.facts;
  const piece = s(facts.piece) || PIECE_NAME[played.piece];
  const title = momentTitle(f, played);
  const oppBehind = Number(facts.oppUndeveloped ?? 0) > 0;
  const tempoNote = oppBehind
    ? ` Since ${opp} was still behind in development${facts.oppKingInCenter ? ' with the king in the center' : ''}, those tempi were valuable.`
    : '';
  const betterIsSecond = betterPly.ply !== played.ply;

  const base: MomentText = {
    title,
    intent: `You played ${played.san}, probably ${guessIntent(played)}.`,
    question: `What would you play here instead of ${played.san}?`,
    predictCorrect: `Yes — that's ${opp}'s most natural answer.`,
    predictOther: `That's possible, but ${opp}'s simplest answer is ${reply?.san ?? 'shown on the board'}.`,
    reveal: '',
    betterPrompt: `What would you play instead of ${betterPly.san}?`,
    betterCorrect: 'Good — that keeps things under control.',
    betterOther: `Not quite. ${bestSan ? `${bestSan} was the cleaner choice.` : ''}`,
    lesson: '',
  };

  switch (f.category) {
    case 'premature_attack': {
      const roundTrip = !!facts.secondSan;
      return {
        ...base,
        intent: `You played ${played.san}. It looks active: the ${piece} attacks ${list((facts.targets as string[] | undefined)?.map((t) => 'the ' + t))}.`,
        question: `Before playing ${played.san}, what is ${opp}'s simplest response? Play ${opp}'s move on the board.`,
        predictCorrect: `Exactly. ${opp} can just play ${reply?.san ?? facts.replySan}.`,
        predictOther: `That's possible, but there's a simpler answer: ${reply?.san ?? facts.replySan}.`,
        reveal: roundTrip
          ? `${opp} simply plays ${s(facts.replySan)}${facts.replyMovedTarget ? ' — the attacked piece just steps away' : ''}. Now the ${piece} has no useful follow-up, and it went back with ${s(facts.secondSan)}. You spent ${facts.tempiLost === 2 ? 'two moves' : 'an extra move'} and the ${piece} ended up ${facts.returned ? 'where it started' : 'no better placed'}.${tempoNote}`
          : `${opp} can simply answer with ${s(facts.engineReplySan || facts.replySan)}. The attack goes nowhere, and you've used your move without improving your position.`,
        betterPrompt: betterIsSecond
          ? `${opp} played ${s(facts.replySan)}. Instead of ${betterPly.san}, what would you do with this move?`
          : `What would you play here instead of ${played.san}?`,
        betterCorrect: `Good — that uses your move for something lasting instead of chasing.`,
        betterOther: `Not quite. ${bestSan ? `${bestSan} is a more useful way to spend the move.` : ''}`,
        lesson:
          "Don't move an already-developed piece again unless it achieves something concrete. Before an active-looking move, find your opponent's simplest reply — if it leaves your piece with nothing to do, play a useful move instead.",
      };
    }
    case 'pointless_check':
      return {
        ...base,
        intent: `You played ${played.san}. A check feels forcing — your opponent has to respond.`,
        question: `Before giving check, what is ${opp}'s most natural reply? Play it on the board.`,
        predictCorrect: `Right. ${reply?.san ?? s(facts.replySan)} answers the check${facts.replyAttacksPiece ? ' and attacks your ' + piece : ''}.`,
        predictOther: `That's legal, but ${opp}'s natural reply is ${reply?.san ?? s(facts.replySan)}${facts.replyAttacksPiece ? ', which blocks and attacks your ' + piece + ' at the same time' : ''}.`,
        reveal: facts.secondSan
          ? `${opp} answers with ${s(facts.replySan)}${facts.replyAttacksPiece ? ', and that move also attacks your ' + piece : ''}. The check gained nothing: the ${piece} had to move again with ${s(facts.secondSan)}. ${opp} got a useful move for free while you spent ${facts.tempiLost === 2 ? 'two moves' : 'an extra move'}.${tempoNote}`
          : `${opp} answers with ${s(facts.replySan)} and the check leads nowhere. Meanwhile, ${bestSan ?? 'a quiet improving move'} would have kept your advantage.`,
        betterPrompt: betterIsSecond
          ? `What would you play instead of ${betterPly.san}?`
          : `Instead of the check, what's a more useful move here?`,
        betterCorrect: 'Good — a quiet move that improves your position beats a check that helps your opponent.',
        lesson:
          'A check is only useful if it gains something. If the natural reply blocks with tempo or improves their position, the check just helps your opponent.',
      };
    case 'inefficient_moves':
      return {
        ...base,
        intent: `You moved the ${piece} from ${s(facts.from)} to ${s(facts.via)}, probably looking for a better square.`,
        question: `What will ${opp} do after ${played.san}? Play ${opp}'s natural reply.`,
        reveal: `After ${s(facts.replySan)}, the ${piece} moved again with ${s(facts.secondSan)}. ${facts.returned ? 'It ended up right where it started' : `It could have reached ${s(facts.to)} in one move`}, so ${facts.tempiLost === 2 ? 'two moves' : 'a move'} went nowhere.${tempoNote}`,
        lesson: 'Every move should improve something. If a piece goes there and back, those moves bought nothing — use them to develop or improve another piece.',
      };
    case 'tactical_blindness': {
      if (facts.mateIn) {
        return {
          ...base,
          intent: `You played ${played.san}, ${guessIntent(played)}. But there was something much stronger.`,
          question: `There's a forced checkmate here. Can you find the first move?`,
          betterPrompt: `There's a forced checkmate here. Can you find the first move?`,
          betterCorrect: `Yes! ${bestSan} starts the mating attack.`,
          betterOther: `Not this time. ${bestSan} forces mate: ${list(facts.bestLine)}.`,
          reveal: `${bestSan} leads to mate: ${list(facts.bestLine)}.`,
          lesson: 'Always check every check. Forcing moves against the king come first in your search.',
        };
      }
      const target = facts.targetPiece ? `the ${s(facts.targetPiece)} on ${s(facts.targetSquare)}` : 'material';
      const by = facts.attackerPiece ? ` with your ${s(facts.attackerPiece)}` : '';
      return {
        ...base,
        intent: `You played ${played.san}, ${guessIntent(played)}. It's a natural move — but there was something better on the board.`,
        question: `There's a way to win material right now. Can you find it?`,
        betterPrompt: `There's a way to win material right now. Can you find it?`,
        betterCorrect: `Yes! ${bestSan} wins ${target}.`,
        betterOther: `Not quite. Look at ${target}: you can take it${by} — ${bestSan}.`,
        reveal: `${bestSan} wins ${target}${facts.targetLoose ? ' because it was attacked by something cheaper' : ''}. After ${list(facts.bestLine)}, you are clearly ahead.`,
        lesson:
          'Before an active-looking move, scan every capture first — especially your pawns attacking bigger pieces. A free piece beats an attack.',
      };
    }
    case 'blunder':
      return {
        ...base,
        question: `After ${played.san}, what can ${opp} do? Play ${opp}'s strongest reply.`,
        predictCorrect: `Exactly — ${s(facts.captureSan) || reply?.san} wins material.`,
        predictOther: `Look again: ${s(facts.captureSan) || s(Array.isArray(facts.replyLine) ? facts.replyLine[0] : '')} wins material.`,
        reveal: facts.mate
          ? `This allows a forced mate: ${list(facts.replyLine)}.`
          : `${s(facts.captureSan)} simply takes the ${s(facts.victimPiece)} on ${s(facts.victimSquare)}. ${facts.movedPieceHung ? 'The piece you just moved' : 'That piece'} had no protection.`,
        betterPrompt: `Find a move that doesn't leave anything loose.`,
        betterCorrect: 'Good — nothing hangs after that.',
        lesson: 'Before you let go of a piece, ask: can it be captured for free on its new square — and did moving it leave something else unprotected?',
      };
    case 'missed_threat':
      return {
        ...base,
        intent: `${opp}'s last move${facts.threatMove ? `, ${s(facts.threatMove)},` : ''} created a threat. You played ${played.san}, ${guessIntent(played)}.`,
        question: `What was ${opp} threatening? Play ${opp}'s threat on the board.`,
        predictCorrect: `Yes — ${s(facts.captureSan)} was the threat.`,
        predictOther: `The real threat was ${s(facts.captureSan)}, winning the ${s(facts.victimPiece)}.`,
        reveal: `Your ${s(facts.victimPiece)} on ${s(facts.victimSquare)} was already under attack, and ${s(facts.captureSan)} takes it.`,
        betterPrompt: `Find a move that deals with the threat.`,
        betterCorrect: 'Good — the threat is handled.',
        lesson: "After every opponent move, ask: what does that move attack? Deal with threats before following your own plan.",
      };
    case 'calculation':
      return {
        ...base,
        question: `After ${played.san}, what is ${opp}'s strongest reply? Play it on the board.`,
        predictCorrect: `Exactly — that's the problem with ${played.san}.`,
        predictOther: `${opp}'s strongest answer is ${s(Array.isArray(facts.replyLine) ? facts.replyLine[0] : '')}.`,
        reveal: `After ${list(facts.replyLine)}, ${opp} comes out ahead.`,
        betterPrompt: `What's a safer move here?`,
        lesson: "Before you commit, look at your opponent's checks, captures and attacks after your move.",
      };
    case 'early_queen':
      return {
        ...base,
        intent: `You moved your queen with ${played.san}, probably looking for an attack.`,
        reveal: `${facts.chasedBy ? `${opp} answered ${s(facts.chasedBy)}, developing with tempo on your queen. ` : ''}Your ${list(facts.undeveloped)} were still at home.`,
        betterPrompt: 'What developing move would you play instead?',
        lesson: 'In the opening, develop knights and bishops before the queen. An early queen gets chased and your opponent develops with tempo.',
      };
    case 'missed_king_attack':
      return {
        ...base,
        intent: `You played ${played.san}. ${opp}'s king was still on ${s(facts.oppKing)}.`,
        betterPrompt: `${opp}'s king is still in the center. How can you open lines toward it?`,
        betterCorrect: `Yes — opening the position while the king is stuck is exactly right.`,
        reveal: `${bestSan} keeps prying the position open while ${opp}'s king can't castle safely: ${list(facts.bestLine)}.`,
        lesson: "When the enemy king is stuck in the center, open lines quickly — pawn breaks and checks — before it escapes.",
      };
    case 'king_safety':
      return {
        ...base,
        reveal: `Moving those pawns opens lines toward your own king on ${s(facts.king)}.`,
        lesson: 'Pawns in front of your castled king are its shield. Move them only for a concrete reason.',
      };
    case 'premature_capture':
    case 'poor_trade':
      return {
        ...base,
        intent: `You captured with ${played.san}.`,
        reveal: `After ${s(facts.replySan)} the material is level again, and ${bestSan} would have kept more pressure.`,
        lesson: 'Before capturing, ask what the trade does for you. If it only helps your opponent develop or relieves their position, keep the tension.',
      };
    case 'failure_to_simplify':
      return {
        ...base,
        reveal: `You were ahead in material. ${bestSan} trades down and makes your extra material count.`,
        lesson: 'When ahead, trade pieces (not pawns) and keep everything protected.',
      };
    case 'endgame':
      return {
        ...base,
        reveal: `${bestSan} was the key endgame move: ${list(facts.bestLine)}.`,
        lesson: 'In the endgame, activate your king and push passed pawns.',
      };
    default:
      return { ...base, lesson: base.lesson || 'Check the opponent\'s best reply before committing.' };
  }
}

export function goodIdeaText(f: Finding, played: PlyRecord, mover: Color): {
  text: MomentText;
  choice: { prompt: string; options: string[]; correct: number; explanation: string };
} {
  const opp = COLOR_NAME[other(mover)];
  const title = momentTitle(f, played);
  const undeveloped = undevelopedMinors(played.fenBefore, other(mover));
  const k = s(f.facts.oppKing);
  const text: MomentText = {
    title,
    intent: `You played ${played.san}. ${opp}'s king is still on ${k}${undeveloped.length ? ` and ${opp} still has pieces at home` : ''}.`,
    question: `Why is ${played.san} a good idea here?`,
    predictCorrect: '',
    predictOther: '',
    reveal: '',
    betterPrompt: '',
    betterCorrect: '',
    betterOther: '',
    lesson:
      "When your king is safe and your opponent's isn't, open the center. Pawn breaks like this create lines for your rooks and bishops to reach the king.",
  };
  const pawn = pieceAt(played.fenAfter, played.to);
  return {
    text,
    choice: {
      prompt: `Why is ${played.san} a good idea here?`,
      options: [
        'It wins material immediately.',
        `${opp}'s king is still in the center, so opening lines helps your pieces reach it.`,
        'It protects your own king.',
        'It prepares to trade queens.',
      ],
      correct: 1,
      explanation: `Your king is castled; ${opp}'s is on ${k}. ${played.san} attacks the center${pawn ? '' : ''} and starts opening lines while ${opp} is behind. That's exactly the right plan — it doesn't need to win material right away.`,
    },
  };
}
