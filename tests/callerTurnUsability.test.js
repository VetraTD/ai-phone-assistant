// ---------------------------------------------------------------------------
// Two questions about a caller's turn that the Live front-end could not ask:
// "did they actually agree to anything?" and "did we understand them at all?"
//
// Both matter because on this path the MODEL is the transcriber. The cascade
// runs Deepgram text through cleanTranscript, so a hesitation arrives as an
// empty turn and never becomes an answer. Here "umm" arrives verbatim and gets
// interpreted, and so does a total ASR failure.
//
// LVX56: the caller said "Ah!" and the assistant executed a reschedule AND a
// name change, then announced them as done.
// LVX50: an English turn came back as the Korean characters "에레는" and was
// answered "Great, 8 AM on Tuesday, September 8th, is available" — and the
// call booked from it.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { isHesitationOnly, isUnusableTranscript, stripFillers } from "../lib/transcriptUtils.js";

describe("isHesitationOnly — a hesitation is not consent", () => {
  // The turn that triggered two writes.
  it("treats a bare hesitation as a hesitation", () => {
    for (const t of ["Ah!", "ah", "umm", "um", "uh", "Uh...", "mm", "hmm", "Hmm.", "er", "erm", "eh"]) {
      expect(isHesitationOnly(t), t).toBe(true);
    }
  });

  // THE REASON THIS IS NOT stripFillers.
  //
  // stripFillers exists to clean a transcript, and its word list is wider than
  // "hesitation" on purpose — it eats discourse markers too. Measured against
  // real confirmations, it reduces "Okay", "OK", "Right", "So" and "Mm-hmm" to
  // the empty string, so a consent gate built on it would refuse a booking when
  // the caller said "Okay." — the single commonest way anyone agrees to
  // anything on a phone call. Meanwhile "uh-huh" survives as "-huh" because
  // `uh+` precedes `uh-huh` in its alternation, so two words meaning the same
  // thing get opposite verdicts.
  //
  // These assertions pin the divergence rather than describing it, so a later
  // tidy-up that merges the two predicates fails here and says why.
  it("does NOT treat an acknowledgement as a hesitation, though stripFillers does", () => {
    for (const t of ["Okay", "Okay.", "OK", "Right", "Right.", "So"]) {
      expect(stripFillers(t), `stripFillers ${t}`).toBe("");
      expect(isHesitationOnly(t), t).toBe(false);
    }
  });

  it("does NOT treat an affirmative grunt as a hesitation", () => {
    // "Mm-hmm" and "uh-huh" mean yes. Refusing to act on them would be its own
    // defect, and a caller who has to escalate from "mm-hmm" to "YES" has been
    // told the assistant is not listening.
    for (const t of ["Mm-hmm", "mm-hmm", "mhm", "uh-huh", "Uh-huh."]) {
      expect(isHesitationOnly(t), t).toBe(false);
    }
  });

  it("does not fire on any real answer", () => {
    for (const t of [
      "Yes",
      "Yeah",
      "Yep",
      "Sure",
      "Correct",
      "That works",
      "Go ahead",
      "Please do",
      "no",
      "Nope",
      "er, yes",
      "um, Tuesday works",
      "uh my name is Nathan",
    ]) {
      expect(isHesitationOnly(t), t).toBe(false);
    }
  });

  it("is false for silence, which a different mechanism owns", () => {
    // An empty turn means the caller said nothing at all. The silence ladder
    // owns that; treating it here would block a legitimate close after a
    // goodbye. Same narrowness the end_call gate was written with.
    expect(isHesitationOnly("")).toBe(false);
    expect(isHesitationOnly("   ")).toBe(false);
    expect(isHesitationOnly(null)).toBe(false);
    expect(isHesitationOnly(undefined)).toBe(false);
  });

  it("handles a repeated hesitation and stray punctuation", () => {
    expect(isHesitationOnly("uh... um,")).toBe(true);
    expect(isHesitationOnly("Uhh, ahh")).toBe(true);
    expect(isHesitationOnly("hmmmm")).toBe(true);
  });
});

describe("isUnusableTranscript — the transcript is not usable", () => {
  it("flags the turn that got booked from (LVX50)", () => {
    expect(isUnusableTranscript("에레는")).toBe(true);
  });

  it("flags other non-Latin scripts on a Latin-script call", () => {
    for (const t of ["안녕하세요", "これはテストです", "привет как дела", "مرحبا كيف حالك", "你好我想预约"]) {
      expect(isUnusableTranscript(t), t).toBe(true);
    }
  });

  it("does NOT flag Spanish, which is a supported locale", () => {
    // Latin covers English and Spanish both. "Hay en el Tíndala" is what a real
    // caller's name came through as on the call that produced LVX53 — garbled,
    // but not unusable in this sense, and a script check must not claim it is.
    for (const t of [
      "Hay en el Tíndala",
      "Sí, quiero una cita para el martes",
      "Mi nombre es José Muñoz",
      "Buenos días, ¿está abierto?",
    ]) {
      expect(isUnusableTranscript(t), t).toBe(false);
    }
  });

  it("does not flag ordinary English, names with diacritics, or digits", () => {
    for (const t of [
      "I'd like to book an appointment on Tuesday",
      "My name is Zoë Brontë",
      "It's Nathan Dodla, D-O-D-L-A",
      "469 933 8887",
      "Ah!",
      "",
    ]) {
      expect(isUnusableTranscript(t), t).toBe(false);
    }
  });

  it("does not flag a turn that is merely mostly digits or punctuation", () => {
    // No letters at all is not the same as letters we cannot read. There is
    // nothing to judge, so it must not be judged unusable.
    expect(isUnusableTranscript("... 3:30")).toBe(false);
    expect(isUnusableTranscript("?!")).toBe(false);
  });

  it("flags a mixed turn only when the unreadable part dominates", () => {
    // A stray emoji-adjacent glyph or one foreign word inside an English
    // sentence is not a failed transcription, and treating it as one is the
    // hair trigger this whole family has to avoid.
    expect(isUnusableTranscript("I want to book 안녕 an appointment please")).toBe(false);
    expect(isUnusableTranscript("에레는 에레는 ok")).toBe(true);
  });
});
