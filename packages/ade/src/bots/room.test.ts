import { describe, expect, test } from "bun:test"
import {
  continuesAfter,
  describeProblem,
  MAX_MEMBERS,
  MAX_ROUNDS,
  mentionedBots,
  MIN_MEMBERS,
  plannedTurns,
  respondersFor,
  roomProblem,
  type RoomMember,
} from "./room"

function bot(name: string, id = name.toLowerCase()): RoomMember {
  return { id, name }
}

const alfa = bot("Alfa")
const beta = bot("Beta")
const rev = bot("Rev")
const revisore = bot("Revisore")
const senior = bot("Revisore Senior", "revisore-senior")

describe("mentionedBots", () => {
  test("finds a bot by the name the user gave it", () => {
    expect(mentionedBots("@Alfa che ne pensi?", [alfa, beta])).toEqual(["alfa"])
  })

  test("is not case sensitive, because nobody types a name twice the same", () => {
    expect(mentionedBots("@alfa e @BETA", [alfa, beta])).toEqual(["alfa", "beta"])
  })

  /*
   * "@alfa, chiedi a @beta" reads as a sequence. Answering it backwards
   * reads as not having been understood.
   */
  test("keeps the order the message mentions them in, not the roster's", () => {
    expect(mentionedBots("@Beta prima, poi @Alfa", [alfa, beta])).toEqual(["beta", "alfa"])
  })

  /*
   * A room holding both "Rev" and "Revisore" had every mention of the
   * longer name also waking the shorter one — which looks like a bot
   * answering a question addressed to somebody else.
   */
  test("a name that is a prefix of another is not woken by it", () => {
    expect(mentionedBots("@Revisore guarda qui", [rev, revisore])).toEqual(["revisore"])
  })

  test("a name with a space in it is still found", () => {
    expect(mentionedBots("@Revisore Senior dai un parere", [senior, rev])).toEqual(["revisore-senior"])
  })

  test("a mention followed by punctuation counts", () => {
    expect(mentionedBots("@Alfa, allora?", [alfa])).toEqual(["alfa"])
    expect(mentionedBots("ok @Alfa.", [alfa])).toEqual(["alfa"])
  })

  test("a bot not in the room is not mentioned even if named", () => {
    expect(mentionedBots("@Beta ci sei?", [alfa])).toEqual([])
  })

  test("no mention is no mention", () => {
    expect(mentionedBots("che ne pensate?", [alfa, beta])).toEqual([])
    expect(mentionedBots("", [alfa, beta])).toEqual([])
  })
})

describe("respondersFor", () => {
  test("the ones mentioned, when any were", () => {
    expect(respondersFor("@Beta?", [alfa, beta])).toEqual(["beta"])
  })

  test("everybody, when nobody was", () => {
    expect(respondersFor("che ne pensate?", [alfa, beta])).toEqual(["alfa", "beta"])
  })

  test("roster order is kept, so the room reads the same way twice", () => {
    expect(respondersFor("allora?", [beta, alfa])).toEqual(["beta", "alfa"])
  })
})

describe("continuesAfter", () => {
  /*
   * Six bots each replying to each other's replies is not a conversation,
   * it is a loop that bills the user for it.
   */
  test("stops at the cap even when everyone still has something to say", () => {
    expect(continuesAfter({ round: MAX_ROUNDS, anyoneSpoke: true })).toBe(false)
    expect(continuesAfter({ round: MAX_ROUNDS + 1, anyoneSpoke: true })).toBe(false)
  })

  test("continues while there is more being said", () => {
    expect(continuesAfter({ round: 1, anyoneSpoke: true })).toBe(true)
  })

  /*
   * Without this the user waits out two empty rounds to discover that
   * nobody had anything to add.
   */
  test("a round where everybody passed ends it", () => {
    expect(continuesAfter({ round: 1, anyoneSpoke: false })).toBe(false)
  })
})

describe("plannedTurns", () => {
  test("every responder, every round, in order", () => {
    const turns = plannedTurns("allora?", [alfa, beta])
    expect(turns).toHaveLength(2 * MAX_ROUNDS)
    expect(turns.slice(0, 2)).toEqual([
      { botId: "alfa", round: 1 },
      { botId: "beta", round: 1 },
    ])
    expect(turns.at(-1)).toEqual({ botId: "beta", round: MAX_ROUNDS })
  })

  test("a mention narrows the plan to the ones addressed", () => {
    expect(plannedTurns("@Alfa?", [alfa, beta])).toHaveLength(MAX_ROUNDS)
  })

  test("rounds are 1-based, so round 1 is the first", () => {
    expect(plannedTurns("allora?", [alfa])[0]!.round).toBe(1)
  })

  test("an empty room plans nothing rather than throwing", () => {
    expect(plannedTurns("ciao", [])).toEqual([])
  })
})

describe("roomProblem", () => {
  test("two to six is a room", () => {
    expect(roomProblem(["a", "b"])).toBeUndefined()
    expect(roomProblem(["a", "b", "c", "d", "e", "f"])).toBeUndefined()
  })

  test("one bot is a chat, and says so", () => {
    expect(roomProblem(["a"])).toBe("troppo-pochi")
    expect(roomProblem([])).toBe("troppo-pochi")
  })

  test("seven is too many", () => {
    expect(roomProblem(["a", "b", "c", "d", "e", "f", "g"])).toBe("troppi")
  })

  test("the same bot twice is caught before the count is", () => {
    expect(roomProblem(["a", "a"])).toBe("duplicati")
    expect(roomProblem(["a", "a", "b", "c", "d", "e", "f", "g"])).toBe("duplicati")
  })

  /*
   * Named rather than boolean because the interface has to say which:
   * "seleziona almeno due bot" and "al massimo sei" are different
   * instructions to the user.
   */
  test("each problem has its own sentence, naming the bound", () => {
    expect(describeProblem("troppo-pochi")).toInclude(String(MIN_MEMBERS))
    expect(describeProblem("troppi")).toInclude(String(MAX_MEMBERS))
    expect(describeProblem("duplicati")).toInclude("due volte")
  })
})
