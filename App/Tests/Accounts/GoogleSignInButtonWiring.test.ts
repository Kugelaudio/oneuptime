import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";

const APP_ROOT: string = path.join(__dirname, "..", "..");
const REPOSITORY_ROOT: string = path.join(APP_ROOT, "..");
const ACCOUNTS_ROOT: string = path.join(
  APP_ROOT,
  "FeatureSet",
  "Accounts",
  "src",
);

function readSource(relativePath: string): string {
  return fs
    .readFileSync(path.join(ACCOUNTS_ROOT, relativePath), "utf8")
    .replace(/\s+/g, " ");
}

describe("Google sign-in on the login page", () => {
  const buttonSource: string = readSource("Components/GoogleSignInButton.tsx");
  const loginSource: string = readSource("Pages/Login.tsx");
  const configSource: string = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "Common", "UI", "Config.ts"),
    "utf8",
  );

  test("is deployment-configured and hidden when Google OIDC is unavailable", () => {
    expect(configSource).toContain('env("PUBLIC_GOOGLE_OIDC_LOGIN_URL")');
    expect(buttonSource).toContain("if (!GoogleOidcLoginUrl)");
    expect(buttonSource).toContain("return null");
  });

  test("navigates directly to the configured Google provider", () => {
    expect(buttonSource).toContain('data-testid="google-sign-in"');
    expect(buttonSource).toContain('t("login.signInWithGoogle")');
    expect(buttonSource).toContain(
      "Navigation.navigate(URL.fromString(GoogleOidcLoginUrl))",
    );
  });

  test("keeps password login and generic SSO available below the button", () => {
    const buttonIndex: number = loginSource.indexOf("<GoogleSignInButton />");
    const passwordFormIndex: number = loginSource.indexOf("<ModelForm<User>");

    expect(buttonIndex).toBeGreaterThan(-1);
    expect(passwordFormIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeLessThan(passwordFormIndex);
    expect(loginSource).toContain('new Route("/accounts/sso")');
  });

  test("has button and divider copy in every supported locale", () => {
    const localesDirectory: string = path.join(ACCOUNTS_ROOT, "Locales");
    const localeFiles: Array<string> = fs
      .readdirSync(localesDirectory)
      .filter((fileName: string) => {
        return fileName.endsWith(".json");
      });

    expect(localeFiles).toHaveLength(16);

    for (const localeFile of localeFiles) {
      const locale: {
        login: { signInWithGoogle?: string; or?: string };
      } = JSON.parse(
        fs.readFileSync(path.join(localesDirectory, localeFile), "utf8"),
      );

      expect([localeFile, locale.login.signInWithGoogle]).toEqual([
        localeFile,
        expect.any(String),
      ]);
      expect([localeFile, locale.login.or]).toEqual([
        localeFile,
        expect.any(String),
      ]);
      expect(locale.login.signInWithGoogle?.trim()).not.toBe("");
      expect(locale.login.or?.trim()).not.toBe("");
    }
  });
});
