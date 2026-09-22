"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: string | number;
  label?: string;
};

export default function CopyableId({ value, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = String(value);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      title={copied ? "ID copiado" : "Clique para copiar o ID"}
      aria-label={`Copiar ID ${text}`}
      style={{
        appearance: "none",
        border: 0,
        padding: 0,
        background: "transparent",
        color: copied ? "var(--green)" : "inherit",
        font: "inherit",
        fontWeight: copied ? 700 : "inherit",
        cursor: "copy",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: 2,
      }}
    >
      {copied ? "✓ Copiado" : label || text}
    </button>
  );
}
