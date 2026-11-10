import { expect, test } from "bun:test";
import { isKintsugiTheme, kintsugiThemes, parseThemeSettings, themeAppearance } from "../src/theme.ts";

const additions = ["catppuccin-mocha", "monokai-pro", "dracula", "gruvbox", "noctis", "lumon", "as400", "synthwave-84", "fallout"] as const;

for (const theme of additions) {
  test(`persisted theme ${theme} is recognised without falling back`, () => {
    expect(isKintsugiTheme(theme)).toBe(true);
    expect(parseThemeSettings(JSON.stringify({ theme }), "nord")).toBe(theme);
    expect(themeAppearance(theme)).toBe("dark");
  });
}

test("existing theme settings retain their identities and defaults", () => {
  for (const theme of ["daylight", "cappuccino", "tokyo-night", "midnight", "nord"] as const) {
    expect(parseThemeSettings(JSON.stringify({ theme }), "daylight")).toBe(theme);
  }
  expect(parseThemeSettings(undefined, "cappuccino")).toBe("cappuccino");
  expect(parseThemeSettings("{}", "nord")).toBe("nord");
  expect(parseThemeSettings('{"theme":"removed-theme"}', "nord")).toBe("nord");
  expect(isKintsugiTheme("petrol")).toBe(false);
  expect(new Set(kintsugiThemes.map(theme => theme.id)).size).toBe(kintsugiThemes.length);
});

test("malformed theme settings remain explicit errors", () => {
  for (const text of ["not JSON", "null", "[]", '{"theme":42}']) expect(() => parseThemeSettings(text, "nord")).toThrow();
});
