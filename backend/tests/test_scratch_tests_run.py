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
    them that its body never runs: the name is never the callee or an argument of a call made by
    the test, where a call inside a local function, lambda or class counts only once that
    function or lambda is itself called or passed (review round 1, Codex). A bare reference
    (`x = body`) doesn't run it. A file that doesn't parse is a problem too."""
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
        run = _run_by(node.body)
        problems += [
            f"{filename}::{node.name}: `{child.name}` is defined and never run"
            for child in node.body
            if isinstance(child, ast.AsyncFunctionDef) and child.name not in run
        ]
    return tests, problems


def _run_by(body: list[ast.stmt]) -> set[str]:
    """Names called or passed by `body` when it runs, following the local functions it calls or
    passes into their own bodies (transitively), and nothing else of theirs."""
    names, local = _calls(body)
    followed: set[str] = set()
    pending = names & local.keys()
    while pending:
        name = pending.pop()
        followed.add(name)
        inner = _run_by(local[name].body)
        names |= inner
        pending |= (inner & local.keys()) - followed
    return names


def _calls(
    body: list[ast.stmt],
) -> tuple[set[str], dict[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    """The names that are the callee, or a positional or keyword argument, of a call in `body`'s
    own scope, and the functions it defines (in any block). Function, lambda and class bodies are
    not entered: a lambda's only when it is itself called or passed."""
    names: set[str] = set()
    local: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    stack: list[ast.AST] = list(body)
    while stack:
        node = stack.pop()
        if isinstance(node, _DEFS):
            local[node.name] = node
            continue
        if isinstance(node, ast.Lambda | ast.ClassDef):
            continue
        if isinstance(node, ast.Call):
            exprs = [node.func, *node.args, *(keyword.value for keyword in node.keywords)]
            while exprs:
                expr = exprs.pop()
                if isinstance(expr, ast.Starred):
                    expr = expr.value
                if isinstance(expr, ast.List | ast.Tuple):
                    exprs += expr.elts
                elif isinstance(expr, ast.Name):
                    names.add(expr.id)
                elif isinstance(expr, ast.Lambda):
                    stack.append(expr.body)
        stack.extend(ast.iter_child_nodes(node))
    return names, local


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


def test_a_call_inside_a_nested_function_that_never_runs_does_not_count() -> None:
    # Review round 1 (Codex, Medium): the scan walked into nested function bodies, so a call inside
    # a never-called function counted as running `body`.
    source = """
def test_publish(scratch_database_url):
    async def body(sessions):
        assert False

    async def wrapper():
        def never_called():
            _run(scratch_database_url, body)

    asyncio.run(wrapper())
"""
    assert _check(source) == ["case.py::test_publish: `body` is defined and never run"]


def test_a_lambda_or_class_that_is_never_run_does_not_count() -> None:
    source = """
def test_lambda(scratch_database_url):
    async def body(sessions):
        assert False
    later = lambda: _run(scratch_database_url, body)

def test_class(scratch_database_url):
    async def body(sessions):
        assert False
    class Runner:
        def go(self):
            _run(scratch_database_url, body)
"""
    assert _check(source) == [
        "case.py::test_lambda: `body` is defined and never run",
        "case.py::test_class: `body` is defined and never run",
    ]


def test_runs_through_called_local_functions_lambdas_and_blocks_count() -> None:
    source = """
def test_inner_def_passed(scratch_database_url):
    async def helper():
        assert False
    async def body(sessions):
        async def act():
            await helper()
        await lock(act=act)
    _run(scratch_database_url, body)

def test_lambda_passed(scratch_database_url):
    async def body(sessions):
        assert False
    _run(scratch_database_url, lambda s: body(s))

def test_def_in_a_block(scratch_database_url):
    async def body(sessions):
        assert False
    with patched():
        async def wrapped(sessions):
            await body(sessions)
        _run(scratch_database_url, wrapped)
"""
    assert unrun_coroutines(source, "case.py") == (3, [])


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
