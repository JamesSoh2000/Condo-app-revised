"""Fitness test: a scratch-database test runs the coroutine it defines (WF-02 criterion 8).

A test that takes `scratch_database_url` builds its world in a nested `async def` and hands it to a
runner (`_run(url, body)`). P6-03b review round 3 found one that defined `body` and never passed it:
the test ran nothing and passed. Checked with `ast`, not a regex (the CLAUDE.md lesson). It does not
catch a test that runs but cannot fail; mutation probes cover that.

Deliberately narrow and fail-closed (WF-02b): it does not work out Python's scopes, because each
review round of PR #142 found a binding form that such analysis missed. It counts only the plainest
ways to run a coroutine, and it refuses a test that binds one of its function names a second time.
"""

import ast
from collections.abc import Iterator
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
FIXTURE = "scratch_database_url"
_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)

type _Def = ast.FunctionDef | ast.AsyncFunctionDef


def unrun_coroutines(source: str, filename: str) -> tuple[int, list[str]]:
    """How many tests take `FIXTURE`, and the problems found in them. A file that doesn't parse
    is a problem too."""
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
        problems += [f"{filename}::{node.name}: {problem}" for problem in _problems(node)]
    return tests, problems


def _problems(test: _Def) -> list[str]:
    """The functions defined directly in the test's body are *tracked*. Each `async def` must be
    run (`_run_by`); a tracked name bound anywhere else in the test fails instead of being
    analysed, and so does an `async def` defined inside a block of the test."""
    tracked: dict[str, _Def] = {}
    for child in test.body:
        if isinstance(child, _DEFS):
            tracked.setdefault(child.name, child)
    problems = [
        f"`{name}` is bound again ({form}, line {line}); give one of them another name"
        for name, form, line in _bindings(test, set(tracked.values()))
        if name in tracked
    ]
    problems += [
        f"`{node.name}` is defined inside a block (line {node.lineno}); "
        "define it directly in the test"
        for node in _own_scope(test.body)
        if isinstance(node, ast.AsyncFunctionDef) and node not in test.body
    ]
    run = _run_by(test.body, tracked)
    problems += [
        f"`{name}` is defined and never run"
        for name, definition in tracked.items()
        if isinstance(definition, ast.AsyncFunctionDef) and name not in run
    ]
    return problems


def _run_by(body: list[ast.stmt], tracked: dict[str, _Def]) -> set[str]:
    """The tracked functions that `body` calls or passes, and those they call or pass in turn."""
    run: set[str] = set()
    pending = [body]
    while pending:
        for name in _called_or_passed(pending.pop()):
            if name in tracked and name not in run:
                run.add(name)
                pending.append(tracked[name].body)
    return run


def _called_or_passed(statements: list[ast.stmt]) -> Iterator[str]:
    """Names that are the callee, or a direct argument, of a call made by an expression
    statement, an assignment's value, a `return` or a `with` item of `statements`, reached through
    calls and `await`s only. A `with` block's body counts (it always runs); an `if`, a loop, a `try`
    or a `match` doesn't (it may not)."""
    for statement in statements:
        match statement:
            case ast.Expr(value=value) | ast.Assign(value=value) | ast.Return(value=value):
                if value is not None:
                    yield from _direct(value)
            case ast.AnnAssign(value=value):
                if value is not None:
                    yield from _direct(value)
            case ast.With(items=items, body=body) | ast.AsyncWith(items=items, body=body):
                for item in items:
                    yield from _direct(item.context_expr)
                yield from _called_or_passed(body)


def _direct(expr: ast.expr) -> Iterator[str]:
    if isinstance(expr, ast.Await):
        yield from _direct(expr.value)
    elif isinstance(expr, ast.Call):
        for part in [expr.func, *expr.args, *(keyword.value for keyword in expr.keywords)]:
            if isinstance(part, ast.Name):
                yield part.id
            else:
                yield from _direct(part)


def _own_scope(body: list[ast.stmt]) -> Iterator[ast.AST]:
    """The nodes of `body`'s scope: function, class and lambda bodies are not entered."""
    stack: list[ast.AST] = list(body)
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, _SCOPES):
            stack.extend(ast.iter_child_nodes(node))


def _bindings(test: _Def, definitions: set[_Def]) -> Iterator[tuple[str, str, int]]:
    """Every name the test binds anywhere inside it, with the binding's form and line, except the
    tracked definitions themselves. Every binding form in Python's grammar is here: none is
    resolved, so a missing form would only let a rebinding through, never hide a problem."""
    targets: dict[int, str] = {}
    for node in ast.walk(test):
        if isinstance(node, ast.comprehension):
            targets |= dict.fromkeys(map(id, ast.walk(node.target)), "comprehension variable")
        elif isinstance(node, ast.For | ast.AsyncFor):
            targets |= dict.fromkeys(map(id, ast.walk(node.target)), "`for` target")
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            targets |= dict.fromkeys(map(id, ast.walk(node.optional_vars)), "`with … as`")
        elif isinstance(node, ast.NamedExpr):
            targets[id(node.target)] = "`:=`"
    for node in ast.walk(test):
        line = getattr(node, "lineno", test.lineno)
        if isinstance(node, _DEFS) and node is not test and node not in definitions:
            yield node.name, "`def`", line
        elif isinstance(node, ast.ClassDef):
            yield node.name, "`class`", line
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Del):
            yield node.id, "`del`", line
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            yield node.id, targets.get(id(node), "assignment"), line
        elif isinstance(node, ast.arg):
            yield node.arg, "parameter", line
        elif isinstance(node, ast.alias):
            yield node.asname or node.name.split(".")[0], "`import`", line
        elif isinstance(node, ast.ExceptHandler) and node.name:
            yield node.name, "`except … as`", line
        elif isinstance(node, ast.MatchAs | ast.MatchStar) and node.name:
            yield node.name, "`match` capture", line
        elif isinstance(node, ast.MatchMapping) and node.rest:
            yield node.rest, "`match` capture", line
        elif isinstance(node, ast.TypeVar | ast.ParamSpec | ast.TypeVarTuple):
            yield node.name, "type parameter", line
        elif isinstance(node, ast.Global | ast.Nonlocal):
            for name in node.names:
                yield name, f"`{type(node).__name__.lower()}`", line


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


def _never_run(*tests: str) -> list[str]:
    return [f"case.py::{test}: `body` is defined and never run" for test in tests]


def test_a_coroutine_that_is_never_passed_fails_naming_the_test() -> None:
    source = """
def test_publish(scratch_database_url):
    async def body(sessions):
        assert False
    migrate(scratch_database_url)
"""
    assert _check(source) == _never_run("test_publish")


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


def test_calls_that_may_not_run_do_not_count() -> None:
    # Inside a nested function that is never run, a lambda, a class, a comprehension, a
    # conditional expression, a boolean operator, an `if`, a loop, a `try` or a `match`.
    source = """
def test_nested_def(scratch_database_url):
    async def body(sessions):
        assert False
    async def wrapper():
        def never_called():
            _run(scratch_database_url, body)
    asyncio.run(wrapper())

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

def test_comprehension(scratch_database_url):
    async def body(sessions):
        assert False
    [_run(scratch_database_url, body) for _ in []]

def test_conditional(scratch_database_url):
    async def body(sessions):
        assert False
    _run(scratch_database_url, body) if False else None

def test_boolean(scratch_database_url):
    async def body(sessions):
        assert False
    False and _run(scratch_database_url, body)

def test_if(scratch_database_url):
    async def body(sessions):
        assert False
    if False:
        _run(scratch_database_url, body)

def test_loop(scratch_database_url):
    async def body(sessions):
        assert False
    for _ in []:
        _run(scratch_database_url, body)

def test_try(scratch_database_url):
    async def body(sessions):
        assert False
    try:
        _run(scratch_database_url, body)
    except Exception:
        pass

def test_match(scratch_database_url):
    async def body(sessions):
        assert False
    match 1:
        case 2:
            _run(scratch_database_url, body)

def test_starred(scratch_database_url):
    async def body(sessions):
        assert False
    _run(scratch_database_url, *[body])
"""
    names = "nested_def lambda class comprehension conditional boolean if loop try match starred"
    assert _check(source) == _never_run(*(f"test_{name}" for name in names.split()))


def test_a_bare_reference_does_not_run_it() -> None:
    source = """
def test_publish(*, scratch_database_url):
    async def body(sessions):
        assert False
    runner = body
    assert body
"""
    assert _check(source) == _never_run("test_publish")


def test_rebinding_a_tracked_name_anywhere_in_the_test_fails_naming_the_binding() -> None:
    # PR #142's three rounds: a shadowing parameter, assignment or local `def` (R2), and a
    # comprehension variable, an `import` or a `class` (R3), each made a call that never ran the
    # test's `body` count as running it.
    cases = {
        "comprehension": ("    [body() for body in [print]]\n", "comprehension variable", 4),
        "import": (
            "    def wrapper():\n        from builtins import print as body\n        body()\n"
            "    wrapper()\n",
            "`import`",
            5,
        ),
        "import_module": (
            "    def wrapper():\n        import body.sub\n    wrapper()\n",
            "`import`",
            5,
        ),
        "class": (
            "    def wrapper():\n        class body:\n            pass\n        body()\n"
            "    wrapper()\n",
            "`class`",
            5,
        ),
        "parameter": (
            "    def wrapper(body):\n        body()\n    wrapper(print)\n",
            "parameter",
            4,
        ),
        "lambda_parameter": (
            "    _run(scratch_database_url, lambda body: body())\n",
            "parameter",
            4,
        ),
        "assignment": ("    body = print\n    body()\n", "assignment", 4),
        "nested_def": (
            "    def wrapper():\n        def body():\n            pass\n        body()\n"
            "    wrapper()\n",
            "`def`",
            5,
        ),
        "second_def": ("    async def body():\n        pass\n    body()\n", "`def`", 4),
        "for": ("    for body in [print]:\n        body()\n", "`for` target", 4),
        "with": ("    with open('x') as body:\n        body()\n", "`with … as`", 4),
        "walrus": ("    (body := print)()\n", "`:=`", 4),
        "except": (
            "    try:\n        pass\n    except Exception as body:\n        pass\n",
            "`except … as`",
            6,
        ),
        "del": ("    del body\n", "`del`", 4),
        "global": ("    def wrapper():\n        global body\n    wrapper()\n", "`global`", 5),
        "nonlocal": (
            "    def wrapper():\n        nonlocal body\n        body = None\n    wrapper()\n",
            "`nonlocal`",
            5,
        ),
        "match": ("    match 1:\n        case body:\n            pass\n", "`match` capture", 5),
        "match_star": (
            "    match []:\n        case [*body]:\n            pass\n",
            "`match` capture",
            5,
        ),
        "match_rest": (
            "    match {}:\n        case {**body}:\n            pass\n",
            "`match` capture",
            5,
        ),
        "type_parameter": (
            "    def wrapper[body]():\n        pass\n    wrapper()\n",
            "type parameter",
            4,
        ),
    }
    for case, (lines, form, line) in cases.items():
        source = (
            "def test_publish(scratch_database_url):\n"
            "    async def body():\n"
            "        assert False\n" + lines + "    _run(scratch_database_url, body)\n"
        )
        rebound = (
            f"case.py::test_publish: `body` is bound again ({form}, line {line}); "
            "give one of them another name"
        )
        assert rebound in _check(source), case


def test_a_test_parameter_with_a_tracked_name_fails() -> None:
    source = """
def test_publish(scratch_database_url, body):
    async def body(sessions):
        assert False
    _run(scratch_database_url, body)
"""
    assert _check(source) == [
        "case.py::test_publish: `body` is bound again (parameter, line 2); "
        "give one of them another name"
    ]


def test_a_run_sibling_that_is_rebound_fails() -> None:
    source = """
def test_publish(scratch_database_url):
    async def body(sessions):
        assert False
    def wrapper():
        _run(scratch_database_url, body)
    wrapper = print
    wrapper()
"""
    assert _check(source) == [
        "case.py::test_publish: `wrapper` is bound again (assignment, line 7); "
        "give one of them another name"
    ]


def test_a_coroutine_defined_inside_a_block_fails() -> None:
    source = """
def test_publish(scratch_database_url):
    with patched():
        async def body(sessions):
            assert False
        _run(scratch_database_url, body)
"""
    assert _check(source) == [
        "case.py::test_publish: `body` is defined inside a block (line 4); "
        "define it directly in the test"
    ]


def test_a_coroutine_passed_called_or_reached_through_a_run_sibling_is_run() -> None:
    source = """
def test_passed(scratch_database_url):
    async def body(sessions):
        assert False
    _run(scratch_database_url, body)

def test_asyncio_run(scratch_database_url):
    async def check():
        assert False
    asyncio.run(check())

def test_called_in_gather(scratch_database_url):
    async def first():
        assert False
    async def second():
        assert False
    results = asyncio.run(main(asyncio.gather(first(), second())))

def test_keyword_and_annotated(scratch_database_url):
    async def one():
        assert False
    async def two():
        assert False
    run(body=one)
    done: bool = run(two)

def test_in_a_with_block(scratch_database_url):
    async def body(sessions):
        assert False
    with patched():
        _run(scratch_database_url, body)

def test_as_a_with_item(scratch_database_url):
    async def body(sessions):
        assert False
    with running(body):
        pass

def test_through_siblings(scratch_database_url):
    async def helper():
        assert False
    async def body(sessions):
        return await helper()
    def wrapper():
        _run(scratch_database_url, body)
    wrapper()

def test_other_tests_are_not_checked(db):
    async def body(sessions):
        assert False
"""
    assert unrun_coroutines(source, "case.py") == (7, [])


def test_a_file_that_does_not_parse_fails() -> None:
    assert _check("def test_x(scratch_database_url):\n    async def body(:\n") == [
        "case.py: cannot be parsed (SyntaxError), so it can't be checked"
    ]
