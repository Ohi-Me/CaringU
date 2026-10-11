import { test } from "node:test";
import assert from "node:assert/strict";
import { screenScam, triageText } from "../src/safety.js";

test("triage: negation and third-party mentions do not raise emergencies", () => {
  assert.equal(triageText("I don't have chest pain, just checking").triage, "routine");
  assert.equal(triageText("My friend fell last week but I'm fine").triage, "routine");
  assert.equal(triageText("I'm not dizzy anymore").triage, "routine");
  assert.equal(triageText("I watched a movie about a heart attack").triage, "routine");
});

test("triage: FAST stroke signs, chest pain, falls with injury are urgent", () => {
  for (const s of ["my arm feels numb and weak on one side", "I can't lift my right arm", "my speech is slurred",
    "crushing pressure in my chest", "I fell and can't get up", "I blacked out"])
    assert.equal(triageText(s).triage, "urgent", s);
});

test("triage: minor complaints are watch, not urgent", () => {
  for (const s of ["my back aches", "feeling a bit lonely", "I slipped but I'm okay", "slight headache today"])
    assert.equal(triageText(s).triage, "watch", s);
});

test("scam: strong patterns are likely_scam; legitimate notices are not", () => {
  assert.equal(screenScam("caller wants me to read him the OTP").verdict, "likely_scam");
  assert.equal(screenScam("he told me to buy gift cards to pay the fine").verdict, "likely_scam");
  assert.equal(screenScam("SMS: your OTP is 1234. Do not share it with anyone").verdict, "no_strong_signals");
  assert.equal(screenScam("your order has been shipped").verdict, "no_strong_signals");
  assert.equal(screenScam("he is still on the line asking for my PIN").in_progress, true);
});

import { setOtherPeople } from "../src/safety.js";

test("crushing-chest metaphors are urgent", () => {
  for (const s of ["there's a heavy weight on my chest", "it feels like a band around my chest", "something crushing my chest"])
    assert.equal(triageText(s).triage, "urgent", s);
});

test("symptoms of other household members are not her emergency; the money request is a scam", () => {
  setOtherPeople(["Ravi", "Neha"]);
  assert.equal(triageText("Ravi collapsed at work, his boss called").triage, "routine");
  assert.equal(triageText("Neha's teacher friend says Neha fainted").triage, "routine");
  assert.equal(triageText("I fainted after Ravi left").triage, "urgent", "her own symptom still counts");
  const s = screenScam("A man says he is Ravi's colleague, Ravi is admitted in hospital, send 15000 on PhonePe now");
  assert.equal(s.verdict, "likely_scam");
});
