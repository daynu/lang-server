#!/usr/bin/env python3
"""Generate word-chain vocabulary JSON files from wordfreq."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from wordfreq import top_n_list


LANGUAGES = {
    "english": "en",
    "german": "de",
    "french": "fr",
}


def vocabulary_key(word: str) -> str:
    compact = re.sub(r"\s+", "", word.strip().lower())
    decomposed = unicodedata.normalize("NFD", compact)
    folded = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return (
        folded
        .replace("œ", "oe")
        .replace("æ", "ae")
        .replace("ß", "ss")
    )


def has_diacritic(word: str) -> bool:
    return vocabulary_key(word) != re.sub(r"\s+", "", word.strip().lower())


def is_candidate(word: str, min_length: int, max_length: int) -> bool:
    compact = re.sub(r"\s+", "", word.strip())
    return (
        min_length <= len(compact) <= max_length
        and compact.isalpha()
    )


def generate_language_words(
    language_code: str,
    source_count: int,
    target_count: int,
    min_length: int,
    max_length: int,
) -> list[dict[str, str]]:
    words_by_key: dict[str, str] = {}

    for word in top_n_list(language_code, source_count):
        display = word.strip().lower()
        if not is_candidate(display, min_length, max_length):
            continue

        key = vocabulary_key(display)
        if not key:
            continue

        current = words_by_key.get(key)
        if current is None or (has_diacritic(display) and not has_diacritic(current)):
            words_by_key[key] = display

        if len(words_by_key) >= target_count:
            break

    return [
        {"display": display, "key": key}
        for key, display in sorted(words_by_key.items(), key=lambda item: item[1])
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate LangBattle word-chain vocabularies from wordfreq."
    )
    parser.add_argument("--target-count", type=int, default=20000)
    parser.add_argument("--source-count", type=int, default=80000)
    parser.add_argument("--min-length", type=int, default=2)
    parser.add_argument("--max-length", type=int, default=24)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "word-chain",
    )
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    for language, code in LANGUAGES.items():
        words = generate_language_words(
            language_code=code,
            source_count=args.source_count,
            target_count=args.target_count,
            min_length=args.min_length,
            max_length=args.max_length,
        )
        payload = {
            "language": language,
            "source": "wordfreq",
            "sourceLanguageCode": code,
            "generatedAt": generated_at,
            "normalization": "lowercase, remove whitespace, NFD accent folding",
            "words": words,
        }
        out_path = args.out_dir / f"{language}.json"
        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"{language}: wrote {len(words)} words to {out_path}")


if __name__ == "__main__":
    main()
