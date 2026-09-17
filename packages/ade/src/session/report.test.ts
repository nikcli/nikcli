import { describe, expect, test } from "bun:test";
import { readReportLine, type SessionReport } from "./report";

describe("readReportLine — tokens", () => {
  test("plain integer count", () => {
    expect(readReportLine({}, "12500 tokens").tokens).toBe(12500);
  });

  test("decimal point with k multiplier", () => {
    expect(readReportLine({}, "1.2k tokens").tokens).toBe(1200);
  });

  test("Italian decimal comma with k multiplier", () => {
    // 3,4k è 3400, non 34000
    expect(readReportLine({}, "3,4k token").tokens).toBe(3400);
  });

  test("arrow-decorated progress line", () => {
    expect(readReportLine({}, "↓ 5.4k tokens").tokens).toBe(5400);
  });

  test("uppercase multipliers", () => {
    expect(readReportLine({}, "2K tokens").tokens).toBe(2000);
    expect(readReportLine({}, "1,2M tokens").tokens).toBe(1200000);
  });

  test("embedded in a sentence", () => {
    expect(readReportLine({}, "Session used 8400 tokens so far").tokens).toBe(
      8400,
    );
  });

  test("ANSI-decorated line", () => {
    expect(readReportLine({}, "\x1b[36m↓ 5.4k tokens\x1b[0m").tokens).toBe(
      5400,
    );
  });

  test("separator without multiplier is ambiguous and discarded", () => {
    // 12,500: decimale all'italiana o migliaia all'inglese? Non si indovina.
    expect(readReportLine({}, "12,500 tokens")).toEqual({});
  });

  test("label-first format is not guessed", () => {
    // Il numero dopo la parola non è nella grammatica riconosciuta.
    expect(readReportLine({}, "Total tokens: 12500")).toEqual({});
  });
});

describe("readReportLine — cost", () => {
  test("dollar amount", () => {
    expect(readReportLine({}, "$0.42").costUsd).toBeCloseTo(0.42);
  });

  test("labeled dollar amount", () => {
    expect(readReportLine({}, "costo: $1.05").costUsd).toBeCloseTo(1.05);
  });

  test("USD suffix with Italian comma", () => {
    expect(readReportLine({}, "(0,18 USD)").costUsd).toBeCloseTo(0.18);
  });

  test("dollari suffix", () => {
    expect(readReportLine({}, "Totale: 0,25 dollari").costUsd).toBeCloseTo(
      0.25,
    );
  });

  test("ANSI-decorated amount", () => {
    expect(readReportLine({}, "\x1b[32m$0.42\x1b[0m").costUsd).toBeCloseTo(
      0.42,
    );
  });

  test("shell variables are not costs", () => {
    expect(readReportLine({}, "$ export PATH=$HOME/bin")).toEqual({});
    expect(readReportLine({}, "$ npm run build")).toEqual({});
  });

  /*
   * I parametri posizionali. `$2` in una riga di awk impostava il costo della
   * sessione a 2,00 $, e siccome il contatore è monotono restava lì fino alla
   * fine — indistinguibile da una spesa vera.
   */
  test("i parametri posizionali di shell non sono costi", () => {
    expect(readReportLine({}, "awk '{print $2}' file.txt")).toEqual({});
    expect(readReportLine({}, "cut -d, -f $3 dati.csv")).toEqual({});
    expect(readReportLine({}, "echo $1 $2 $3")).toEqual({});
    expect(readReportLine({}, 'sed -n "${1}p" x')).toEqual({});
    expect(readReportLine({}, "for i in $(seq 1 10); do echo $i; done")).toEqual({});
  });

  test("un intero tondo senza unità non viene preso per un prezzo", () => {
    // Direzione voluta: un costo mancato si nota, uno inventato no.
    expect(readReportLine({}, "il file costa $5 di spazio").costUsd).toBeUndefined();
    // Con l'unità scritta per esteso invece si legge.
    expect(readReportLine({}, "totale 5 USD").costUsd).toBeCloseTo(5);
  });
});

describe("readReportLine — model", () => {
  test("'Using model:' declaration", () => {
    expect(readReportLine({}, "Using model: claude-opus-4-6").model).toBe(
      "claude-opus-4-6",
    );
  });

  test("key=value declaration", () => {
    expect(readReportLine({}, "model=gpt-5.4").model).toBe("gpt-5.4");
  });

  test("bare key: declaration", () => {
    expect(readReportLine({}, "model: gemini-3-pro").model).toBe(
      "gemini-3-pro",
    );
  });

  test("trailing sentence punctuation is stripped", () => {
    expect(readReportLine({}, "model: gpt-5.4.").model).toBe("gpt-5.4");
  });

  test("prose after the keyword is rejected", () => {
    expect(readReportLine({}, "model: is unclear")).toEqual({});
  });

  test("latest declaration wins", () => {
    let report = readReportLine({}, "Using model: claude-opus-4-6");
    report = readReportLine(report, "model=gpt-5.4");
    expect(report.model).toBe("gpt-5.4");
  });
});

describe("readReportLine — activity", () => {
  test("Italian gerund", () => {
    expect(readReportLine({}, "Ragionando…").activity).toBe("Ragionando…");
  });

  test("gerund with object", () => {
    const line = "Scrivendo il file index.ts…";
    expect(line.length).toBeLessThanOrEqual(40);
    expect(readReportLine({}, line).activity).toBe(line);
  });

  test("English gerund", () => {
    expect(readReportLine({}, "Reading files…").activity).toBe(
      "Reading files…",
    );
  });

  test("state verb from the known list", () => {
    expect(readReportLine({}, "Cerco nel workspace…").activity).toBe(
      "Cerco nel workspace…",
    );
  });

  test("ASCII ellipsis works too", () => {
    expect(readReportLine({}, "Compiling project...").activity).toBe(
      "Compiling project...",
    );
  });

  test("ANSI-decorated spinner line", () => {
    expect(readReportLine({}, "\x1b[90mRagionando…\x1b[0m").activity).toBe(
      "Ragionando…",
    );
  });

  test("long line is truncated at a word boundary", () => {
    const line =
      "Analizzando la struttura del pacchetto per capire dove intervenire…";
    const activity = readReportLine({}, line).activity!;
    expect(activity).toBe("Analizzando la struttura del pacchetto");
    expect(activity.length).toBeLessThanOrEqual(40);
    // Il taglio cade esattamente su uno spazio: nessuna parola a metà.
    expect(line.startsWith(activity)).toBe(true);
    expect(line[activity.length]).toBe(" ");
  });

  test("ellipsis-only or non-verb lines are ignored", () => {
    expect(readReportLine({}, "Cosa devo fare...")).toEqual({});
    expect(readReportLine({}, "Attendere prego…")).toEqual({});
    expect(readReportLine({}, "…")).toEqual({});
  });

  test("latest activity replaces the previous one", () => {
    let report = readReportLine({}, "Ragionando…");
    report = readReportLine(report, "Scrivendo…");
    expect(report.activity).toBe("Scrivendo…");
  });
});

describe("readReportLine — righe irrilevanti", () => {
  test("bare numbers without units are nothing", () => {
    expect(readReportLine({}, "42")).toEqual({});
    expect(readReportLine({}, "3.5")).toEqual({});
  });

  test("percentages are not tokens", () => {
    expect(readReportLine({}, "50% completato")).toEqual({});
  });

  test("file sizes are neither tokens nor costs", () => {
    expect(readReportLine({}, "1.2 MB salvati su disco")).toEqual({});
    expect(readReportLine({}, "scaricati 340 kB")).toEqual({});
  });

  test("line numbers and code are not consumption", () => {
    expect(readReportLine({}, "142: const retries = 3")).toEqual({});
  });

  test("config values are not consumption", () => {
    expect(readReportLine({}, "max_tokens: 4096")).toEqual({});
  });

  test("empty and whitespace lines change nothing", () => {
    expect(readReportLine({}, "")).toEqual({});
    expect(readReportLine({}, "   ")).toEqual({});
  });
});

describe("readReportLine — non-regressione", () => {
  test("tokens never go down", () => {
    const current: SessionReport = { tokens: 5400 };
    const next = readReportLine(current, "1.2k tokens");
    expect(next.tokens).toBe(5400);
    expect(next).toBe(current);
  });

  test("cost never goes down", () => {
    const current: SessionReport = { costUsd: 1.05 };
    expect(readReportLine(current, "$0.42").costUsd).toBeCloseTo(1.05);
    expect(readReportLine(current, "(0,18 USD)")).toBe(current);
  });

  test("equal values keep the report untouched", () => {
    const current: SessionReport = { tokens: 1200, costUsd: 0.3 };
    expect(readReportLine(current, "1.2k tokens · $0,30 USD")).toBe(current);
  });

  test("a folded stream of realistic lines never regresses", () => {
    const lines = [
      "↓ 1.0k tokens",
      "\x1b[2KRagionando…\x1b[0m",
      "↓ 5.4k tokens",
      "costo: $0.20",
      "partial flush ↓ 900 tokens",
      "costo: $0.08",
      "↓ 12k tokens",
      "$0.55",
      "Scrivendo il file report.ts…",
    ];
    let report: SessionReport = {};
    for (const line of lines) {
      const next = readReportLine(report, line);
      if (report.tokens !== undefined) {
        expect(next.tokens!).toBeGreaterThanOrEqual(report.tokens!);
      }
      if (report.costUsd !== undefined) {
        expect(next.costUsd!).toBeGreaterThanOrEqual(report.costUsd!);
      }
      report = next;
    }
    expect(report.tokens).toBe(12000);
    expect(report.costUsd).toBeCloseTo(0.55);
    expect(report.activity).toBe("Scrivendo il file report.ts…");
  });
});

describe("readReportLine — purezza e righe combinate", () => {
  test("status line carrying several fields at once", () => {
    const next = readReportLine(
      {},
      "↓ 5.4k tokens · $0.42 · model=claude-opus-4-6",
    );
    expect(next).toEqual({
      tokens: 5400,
      costUsd: 0.42,
      model: "claude-opus-4-6",
    });
  });

  test("does not mutate the current report", () => {
    const current: SessionReport = {
      tokens: 500,
      costUsd: 0.1,
      model: "gpt-5.4",
      activity: "Leggo…",
    };
    const snapshot = { ...current };
    let next = readReportLine(current, "↓ 2.0k tokens · $0.42");
    next = readReportLine(next, "model=claude-opus-4-6");
    next = readReportLine(next, "Scrivendo…");
    expect(current).toEqual(snapshot);
    expect(next).toEqual({
      tokens: 2000,
      costUsd: 0.42,
      model: "claude-opus-4-6",
      activity: "Scrivendo…",
    });
  });

  test("returns the same object when the line says nothing useful", () => {
    const current: SessionReport = { tokens: 100 };
    expect(readReportLine(current, "hello world")).toBe(current);
  });
});
