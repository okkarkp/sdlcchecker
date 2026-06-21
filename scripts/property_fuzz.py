#!/usr/bin/env python3
"""Property-based & fuzz testing — tiny, dependency-free, with shrinking.

A minimal property tester in the spirit of Hypothesis / QuickCheck: you declare a property
that must hold for ALL inputs drawn from a strategy; it samples many random inputs, and when
it finds a failure it SHRINKS to a minimal counterexample before reporting — so you get
"[0, 0, 0]" instead of "[7, 3, 9, 2]". Use it inside your normal test suite (pytest, etc.) —
no new dependency. For exhaustive stateful / model-based testing at scale, graduate to
Hypothesis; this is the zero-setup default that ships with the pipeline.

    from property_fuzz import for_all, ints, lists, text

    @for_all(lists(ints(0, 1000)))
    def test_sort_is_idempotent(xs):
        assert sorted(sorted(xs)) == sorted(xs)

    test_sort_is_idempotent()      # runs N random cases; raises with a minimal counterexample
"""

from __future__ import annotations

import argparse
import random
import sys
from typing import Any, Callable, Iterator, List, Tuple


class Strategy:
    """Draws random values and shrinks a failing value toward something simpler."""

    def draw(self, rnd: random.Random) -> Any:                  # pragma: no cover - interface
        raise NotImplementedError

    def shrink(self, value: Any) -> Iterator[Any]:              # pragma: no cover - interface
        return iter(())


class _Ints(Strategy):
    def __init__(self, lo: int = -1000, hi: int = 1000):
        self.lo, self.hi = lo, hi

    def draw(self, rnd: random.Random) -> int:
        return rnd.randint(self.lo, self.hi)

    def shrink(self, value: int) -> Iterator[int]:
        target = 0 if self.lo <= 0 <= self.hi else self.lo
        if value == target:
            return
        # Bisection candidates ASCENDING from target toward value. The engine accepts the
        # first one that still fails, so it narrows onto the boundary (e.g. n<100 -> 100)
        # in O(log) steps rather than overshooting past it.
        diff = value - target
        cands = [target]
        f = 2
        while abs(diff) // f >= 1:
            cands.append(value - diff // f)
            f *= 2
        seen = set()
        for c in sorted(cands, key=lambda c: abs(c - target)):
            if c != value and c not in seen:
                seen.add(c)
                yield c


class _Floats(Strategy):
    def __init__(self, lo: float = -1e6, hi: float = 1e6):
        self.lo, self.hi = lo, hi

    def draw(self, rnd: random.Random) -> float:
        return rnd.uniform(self.lo, self.hi)

    def shrink(self, value: float) -> Iterator[float]:
        if value != 0.0 and self.lo <= 0.0 <= self.hi:
            yield 0.0
            yield value / 2.0


class _Booleans(Strategy):
    def draw(self, rnd: random.Random) -> bool:
        return rnd.random() < 0.5

    def shrink(self, value: bool) -> Iterator[bool]:
        if value:
            yield False


class _Text(Strategy):
    def __init__(self, alphabet: str = "abcdefghijklmnopqrstuvwxyz0123456789 ", max_len: int = 16):
        self.alphabet, self.max_len = alphabet, max_len

    def draw(self, rnd: random.Random) -> str:
        n = rnd.randint(0, self.max_len)
        return "".join(rnd.choice(self.alphabet) for _ in range(n))

    def shrink(self, value: str) -> Iterator[str]:
        if value:
            yield ""
            for i in range(len(value)):                         # drop one character
                yield value[:i] + value[i + 1:]


class _Lists(Strategy):
    def __init__(self, elem: Strategy, max_len: int = 12):
        self.elem, self.max_len = elem, max_len

    def draw(self, rnd: random.Random) -> list:
        n = rnd.randint(0, self.max_len)
        return [self.elem.draw(rnd) for _ in range(n)]

    def shrink(self, value: list) -> Iterator[list]:
        if value:
            yield []
            for i in range(len(value)):                         # drop one element
                yield value[:i] + value[i + 1:]
            for i in range(len(value)):                         # shrink one element
                for s in self.elem.shrink(value[i]):
                    yield value[:i] + [s] + value[i + 1:]


def ints(lo: int = -1000, hi: int = 1000) -> Strategy:
    return _Ints(lo, hi)


def floats(lo: float = -1e6, hi: float = 1e6) -> Strategy:
    return _Floats(lo, hi)


def booleans() -> Strategy:
    return _Booleans()


def text(alphabet: str = "abcdefghijklmnopqrstuvwxyz0123456789 ", max_len: int = 16) -> Strategy:
    return _Text(alphabet, max_len)


def lists(elem: Strategy, max_len: int = 12) -> Strategy:
    return _Lists(elem, max_len)


def _holds(prop: Callable, args: Tuple) -> bool:
    """A property 'holds' for args if it returns without raising."""
    try:
        prop(*args)
        return True
    except Exception:
        return False


def _shrink(prop: Callable, strategies: Tuple[Strategy, ...], args: Tuple) -> Tuple:
    """Greedily replace each arg with a simpler failing value until none improves."""
    current = list(args)
    improved = True
    while improved:
        improved = False
        for i, st in enumerate(strategies):
            for cand in st.shrink(current[i]):
                trial = list(current)
                trial[i] = cand
                if not _holds(prop, tuple(trial)):
                    current = trial
                    improved = True
                    break
    return tuple(current)


def for_all(*strategies: Strategy, iters: int = 200, seed: int = 0) -> Callable:
    """Decorate a property fn; the returned callable runs the property over random inputs."""
    def decorate(prop: Callable) -> Callable:
        def runner() -> bool:
            rnd = random.Random(seed)
            for _ in range(iters):
                args = tuple(st.draw(rnd) for st in strategies)
                if not _holds(prop, args):
                    minimal = _shrink(prop, strategies, args)
                    shown = minimal[0] if len(minimal) == 1 else minimal
                    raise AssertionError(
                        f"property '{getattr(prop, '__name__', 'property')}' "
                        f"failed for {shown!r}"
                    )
            return True
        runner.__name__ = getattr(prop, "__name__", "property")
        runner.__doc__ = prop.__doc__
        return runner
    return decorate


def _self_test(stream=sys.stdout) -> int:
    """Smoke-test the engine itself: a true property passes, a false one shrinks."""
    @for_all(lists(ints(0, 1000)), seed=1)
    def holds(xs):
        assert sorted(sorted(xs)) == sorted(xs)
    holds()

    @for_all(lists(ints(0, 9), max_len=8), seed=1)
    def fails(xs):
        assert len(xs) < 3
    try:
        fails()
    except AssertionError as exc:
        print(f"property_fuzz self-test OK — shrank to: {exc}", file=stream)
        return 0
    print("property_fuzz self-test FAILED — counterexample not found", file=stream)
    return 1


def main(argv: "List[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description="Tiny property-based / fuzz tester (importable library).")
    ap.add_argument("--self-test", action="store_true", help="run the engine's own smoke test")
    a = ap.parse_args(argv)
    if a.self_test:
        return _self_test()
    print("property_fuzz is a library — import for_all, ints, lists, text, … in your tests. "
          "Run with --self-test to verify the engine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
