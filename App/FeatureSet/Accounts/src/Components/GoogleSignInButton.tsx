import { GoogleOidcLoginUrl } from "Common/UI/Config";
import Navigation from "Common/UI/Utils/Navigation";
import URL from "Common/Types/API/URL";
import React, { FunctionComponent, ReactElement } from "react";
import { useTranslation } from "react-i18next";

const GoogleSignInButton: FunctionComponent = (): ReactElement | null => {
  const { t } = useTranslation();

  if (!GoogleOidcLoginUrl) {
    return null;
  }

  return (
    <div className="mb-6">
      <button
        type="button"
        data-testid="google-sign-in"
        aria-label={t("login.signInWithGoogle")}
        onClick={() => {
          Navigation.navigate(URL.fromString(GoogleOidcLoginUrl));
        }}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        <svg
          aria-hidden="true"
          className="h-5 w-5"
          viewBox="0 0 18 18"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fill="#4285F4"
            d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.909c1.702-1.567 2.683-3.874 2.683-6.614Z"
          />
          <path
            fill="#34A853"
            d="M9 18c2.43 0 4.468-.806 5.957-2.181l-2.909-2.258c-.806.54-1.835.859-3.048.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z"
          />
          <path
            fill="#FBBC05"
            d="M3.963 10.706A5.42 5.42 0 0 1 3.682 9c0-.592.102-1.168.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z"
          />
          <path
            fill="#EA4335"
            d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.582-2.582C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z"
          />
        </svg>
        <span>{t("login.signInWithGoogle")}</span>
      </button>

      <div className="mt-6 flex items-center" aria-hidden="true">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="px-3 text-xs uppercase tracking-wide text-gray-400">
          {t("login.or")}
        </span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>
    </div>
  );
};

export default GoogleSignInButton;
