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
