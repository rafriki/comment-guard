// Tests for the pure heuristic classifier. Run: `node --test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicScore } from "../src/classifier.js";

test("flags generic praise", () => {
  const v = heuristicScore({ text: "Great post! Thanks for sharing 🙏" });
  assert.equal(v.spam, true);
  assert.ok(v.confidence >= 0.5, `confidence was ${v.confidence}`);
});

test("flags AI filler", () => {
  const v = heuristicScore({
    text: "In today's fast-paced world, this is a game-changer that underscores the importance of synergy.",
  });
  assert.equal(v.spam, true);
});

test("flags promotional spam", () => {
  const v = heuristicScore({ text: "Love this! DM me to book a call, link in bio 🔗" });
  assert.equal(v.spam, true);
});

test("flags emoji-only", () => {
  const v = heuristicScore({ text: "🔥🔥🔥👏" });
  assert.equal(v.spam, true);
});

test("does NOT flag a substantive comment", () => {
  const v = heuristicScore({
    text:
      "I tried this approach on a 12-node Kafka cluster and the rebalancing latency dropped from 400ms to about 90ms. The tradeoff was higher memory on the brokers though — did you see that too?",
  });
  assert.equal(v.spam, false, `reason: ${v.reason}`);
});

test("does NOT flag a short but specific reply", () => {
  const v = heuristicScore({ text: "Which Postgres version did you benchmark this on?" });
  assert.equal(v.spam, false, `reason: ${v.reason}`);
});

test("empty comment is not spam", () => {
  const v = heuristicScore({ text: "" });
  assert.equal(v.spam, false);
});
