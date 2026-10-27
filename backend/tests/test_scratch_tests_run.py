"""Fitness test: a scratch-database test runs the coroutine it defines (WF-02 criterion 8).

A test that takes `scratch_database_url` builds its world in a nested `async def` and hands it to a
runner (`_run(url, body)`). P6-03b review round 3 found one that defined `body` and never passed it:
the test ran nothing and passed. Checked with `ast`, not a regex (the CLAUDE.md lesson). It does not
catch a test that runs but cannot fail; mutation probes cover that.
"""

import ast
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
FIXTURE = "scratch_database_url"
_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)


def unrun_coroutines(source: str, filename: str) -> tuple[int, list[str]]:
    """How many tests take `FIXTURE`, and one problem per `async def` nested directly in one of
    them that its body never runs: the name is never the callee or an argument of a call in the
    test's own statements, nor in a sibling nested function those statements run (transitively).
    A bare reference (`x = body`) doesn't run it. A file that doesn't parse is a problem too."""
    try:
        tree = ast.parse(source, filename)
    except (SyntaxError, ValueError) as exc:
        return 0, [f"{filename}: cannot be parsed ({type(exc).__name__}), so it can't be checked"]
    tests = 0
    problems: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, _DEFS) or not node.name.startswith("test"):
            continue
        params = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if FIXTURE not in {param.arg for param in params}:
            continue
        tests += 1
        nested = {child.name: child for child in node.body if isinstance(child, _DEFS)}
        own = [child for child in node.body if not isinstance(child, _DEFS)]
        run: set[str] = set()
        pending = _called_or_passed(own) & nested.keys()
        while pending:
            name = pending.pop()
            run.add(name)
            pending |= (_called_or_passed(nested[name].body) & nested.keys()) - run
        problems += [
            f"{filename}::{node.name}: `{name}` is defined and never run"
            for name, child in nested.items()
            if isinstance(child, ast.AsyncFunctionDef) and name not in run
        ]
    return tests, problems


def _called_or_passed(statements: list[ast.stmt]) -> set[str]:
    """Names that are the callee, or a positional or keyword argument, of a call in `statements`."""
    names: set[str] = set()
    for statement in statements:
        for call in ast.walk(statement):
            if not isinstance(call, ast.Call):
                continue
            exprs = [call.func, *call.args, *(keyword.value for keyword in call.keywords)]
            while exprs:
                expr = exprs.pop()
                if isinstance(expr, ast.Starred):
                    expr = expr.value
                if isinstance(expr, ast.List | ast.Tuple):
                    exprs += expr.elts
                elif isinstance(expr, ast.Name):
                    names.add(expr.id)
    return names


def test_every_scratch_database_test_runs_the_coroutine_it_defines() -> None:
    tests = 0
    problems: list[str] = []
    for path in sorted(TESTS_DIR.rglob("*.py")):
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            problems.append(f"{path}: not UTF-8, so it can't be checked")
            continue
        found, wrong = unrun_coroutines(source, str(path.relative_to(TESTS_DIR)))
        tests += found
        problems += wrong

    assert problems == []
    # The scan found the tests it is about (81 at WF-02), so it can't pass by finding none.
    assert tests >= 81


def _check(source: str) -> list[str]:
    return unrun_coroutines(source, "case.py")[1]


def test_a_coroutine_that_is_never_passed_fails_naming_the_test() -> None:
    source = """
def test_publish(scratch_database_url):
    async def body(sessions):
        assert False
    migrate(scratch_database_url)
"""
    assert _check(source) == ["case.py::test_publish: `body` is defined and never run"]


def test_a_coroutine_used_only_inside_a_sibling_that_never_runs_fails() -> None:
    source = """
def test_publish(scratch_database_url, monkeypatch):
    async def body(sessions):
        assert False

    async def unused():
        await body(None)

    migrate(scratch_database_url)
"""
    assert _check(source) == [
        "case.py::test_publish: `body` is defined and never run",
        "case.py::test_publish: `unused` is defined and never run",
    ]


def test_a_bare_reference_does_not_run_it() -> None:
    source = """
def test_publish(*, scratch_database_url):
    async def body(sessions):
        assert False
    runner = body
    assert body
"""
    assert _check(source) == ["case.py::test_publish: `body` is defined and never run"]


def test_a_coroutine_passed_called_or_reached_through_a_passed_sibling_is_run() -> None:
    source = """
def test_passed(scratch_database_url):
    async def body(sessions):
        assert False
    _run(scratch_database_url, body)

def test_called_in_gather(scratch_database_url):
    async def first():
        assert False
    async def second():
        assert False
    asyncio.run(main(asyncio.gather(first(), second())))

def test_keyword_and_starred(scratch_database_url):
    async def one():
        assert False
    async def two():
        assert False
    run(body=one, *[two])

def test_through_a_sibling(scratch_database_url):
    async def helper():
        assert False
    async def body(sessions):
        await helper()
    _run(scratch_database_url, body)

def test_other_tests_are_not_checked(db):
    async def body(sessions):
        assert False
"""
    assert unrun_coroutines(source, "case.py") == (4, [])


def test_a_file_that_does_not_parse_fails() -> None:
    assert _check("def test_x(scratch_database_url):\n    async def body(:\n") == [
        "case.py: cannot be parsed (SyntaxError), so it can't be checked"
    ]
