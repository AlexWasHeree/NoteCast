#!/usr/bin/env python3
"""
Topic extractor using YAKE (Yet Another Keyword Extractor).
Input (stdin): JSON {"title": "...", "content": "..."}
Output (stdout): JSON array ["kw1", "kw2", ...]

Install: pip install yake
"""
import sys
import json

def extract_topics(text: str, max_keywords: int = 8) -> list[str]:
    try:
        import yake
        kw_extractor = yake.KeywordExtractor(
            lan="pt",
            n=2,           # max ngram size
            dedupLim=0.7,
            top=max_keywords,
            features=None,
        )
        keywords = kw_extractor.extract_keywords(text)
        return [kw for kw, _score in keywords]
    except ImportError:
        # Graceful degradation: simple frequency-based fallback
        import re
        words = re.findall(r'\b[a-zA-ZÀ-ÿ]{4,}\b', text.lower())
        stopwords = {'para', 'com', 'que', 'uma', 'como', 'mais', 'seus', 'suas',
                     'esse', 'essa', 'este', 'esta', 'pelo', 'pela', 'num', 'numa',
                     'são', 'sem', 'por', 'não', 'também', 'onde', 'cada', 'entre'}
        freq: dict[str, int] = {}
        for w in words:
            if w not in stopwords:
                freq[w] = freq.get(w, 0) + 1
        sorted_words = sorted(freq.items(), key=lambda x: x[1], reverse=True)
        return [w for w, _ in sorted_words[:max_keywords]]

def main():
    try:
        data = json.loads(sys.stdin.read())
        title = data.get("title", "")
        content = data.get("content", "")
        text = f"{title}. {content}"
        topics = extract_topics(text)
        print(json.dumps(topics))
    except Exception as e:
        sys.stderr.write(f"Error: {e}\n")
        print(json.dumps([]))

if __name__ == "__main__":
    main()
