"""Fitness test: a scratch-database test runs the coroutine it defines (WF-02 criterion 8, WF-02c).

A test that takes `scratch_database_url` builds its world in a nested `async def` and hands it to a
runner (`_run(url, body)`). P6-03b review round 3 found one that defined `body` and never passed it:
the test ran nothing and passed. Checked with `ast`, not a regex (the CLAUDE.md lesson). It does not
catch a test that runs but cannot fail; mutation probes cover that.

Deliberately narrow and fail-closed (WF-02b, WF-02c): it does not work out Python's scopes, because
each review round of PR #142 found a binding form that such analysis missed, and it refuses a test
that binds one of its function names a second time. It counts only the plainest ways to run a
coroutine, and draws one trust boundary: code from outside the test (a module function such as
`_run`, a fixture, a library, an import) is trusted to run what it is handed; code inside the
test is read, never trusted. So `print(body)` passes (a limitation), and `ignore(body)` with
`ignore` defined in the test fails.
"""

import ast
import asyncio
import inspect
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any, NamedTuple

import pytest

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
    analysed, and so does a decorated one and an `async def` defined inside a block of the test."""
    tracked: dict[str, _Def] = {}
    for child in test.body:
        if isinstance(child, _DEFS):
            tracked.setdefault(child.name, child)
    problems = [
        f"`{name}` is bound again ({form}, line {line}); give one of them another name"
        for name, form, line in _bindings(test, {test, *tracked.values()})
        if name in tracked
    ]
    problems += [
        f"`{node.name}` is defined inside a block (line {node.lineno}); "
        "define it directly in the test"
        for node in _own_scope(test.body)
        if isinstance(node, ast.AsyncFunctionDef) and node not in test.body
    ]
    problems += [
        f"`{name}` is decorated (line {definition.lineno}); the check can't tell what the "
        "decorator returns, so don't decorate it"
        for name, definition in tracked.items()
        if definition.decorator_list
    ]
    run = _run_by(test.body, _Test(tracked, _trusted(test), _raising(tracked)))
    problems += [
        f"`{name}` is defined and never run"
        for name, definition in tracked.items()
        if isinstance(definition, ast.AsyncFunctionDef) and name not in run
    ]
    return problems


class _Test(NamedTuple):
    tracked: dict[str, _Def]
    trusted: set[str]  # callee roots that are code from outside the test (`_trusted`)
    raising: set[str]  # tracked functions that may raise (`_raising`)


def _trusted(test: _Def) -> set[str]:
    """The names whose calls are code from outside the test: each is only ever the root of a callee
    (`a` in `a.b(...)`), and the test binds it only by `import`, if at all. A name used any other
    way (`setattr(a, …)`, `alias = a`, `a.b = …`) may have been changed by the test (round 1 F2).
    None at all if the test stores into an attribute or item of something it didn't bind
    (`globals()["_run"] = …`, an outside object's attribute): that can rebind any name."""
    bound = {
        name
        for statement in test.body
        for name, form, _ in _bindings(statement, set())
        if form != "`import`"
    }
    for node in ast.walk(test):
        if isinstance(node, ast.Attribute | ast.Subscript) and isinstance(
            node.ctx, ast.Store | ast.Del
        ):
            target: ast.expr = node
            while isinstance(target, ast.Attribute | ast.Subscript):
                target = target.value
            if not (isinstance(target, ast.Name) and target.id in bound):
                return set()
    roots = {id(_root(node.func)) for node in ast.walk(test) if isinstance(node, ast.Call)}
    names = [node for node in ast.walk(test) if isinstance(node, ast.Name)]
    used_otherwise = {node.id for node in names if id(node) not in roots}
    return {node.id for node in names if id(node) in roots} - used_otherwise - bound


def _raising(tracked: dict[str, _Def]) -> set[str]:
    """The tracked functions that may raise: a `raise` anywhere inside one (in a nested function
    too), or a reference to one that may. A statement that runs one can end the test (with
    `pytest.skip`'s exception, green) before the statements after it (round 1 F1)."""
    raising = {
        name
        for name, definition in tracked.items()
        if any(isinstance(node, ast.Raise) for node in ast.walk(definition))
    }
    grown = True
    while grown:
        grown = False
        for name, definition in tracked.items():
            if name not in raising and _refers_to(ast.walk(definition), raising):
                raising.add(name)
                grown = True
    return raising


def _refers_to(nodes: Iterable[ast.AST], names: set[str]) -> bool:
    return any(isinstance(node, ast.Name) and node.id in names for node in nodes)


def _run_by(body: list[ast.stmt], test: _Test) -> set[str]:
    """The tracked functions that `body` runs, and those they run in turn. Only a function the test
    calls directly is read further: code that is handed a function may catch its errors
    (`pytest.raises(E, f)`, `gather(..., return_exceptions=True)`), so a statement in it that
    raises could skip the rest without failing the test."""
    run: set[str] = set()
    read: set[str] = set()
    pending = [body]
    while pending:
        for name, called in _runs(pending.pop(), test):
            run.add(name)
            if called and name not in read:
                read.add(name)
                pending.append(test.tracked[name].body)
    return run


def _runs(statements: list[ast.stmt], test: _Test) -> Iterator[tuple[str, bool]]:
    """(name, called directly) for the tracked functions run by an expression statement, an
    assignment's value, a `return`'s value or the *first* item of a `with` in `statements`, up to
    the first statement that can leave: one whose own scope holds a `return` or `raise`, or refers
    to a tracked function that may raise (its counted part runs before it can leave). No block's
    body counts: an `if`, a loop, a `try` or a `match` may not run it, and a `with` may suppress an
    error raised before the call (`pytest.raises` does; PR #145 round 3). A later `with` item runs
    inside the earlier ones, which may suppress it too (round 4)."""
    for statement in statements:
        match statement:
            case ast.Expr(value=value) | ast.Assign(value=value) | ast.Return(value=value):
                if value is not None:
                    yield from _evaluated(value, test)
            case ast.AnnAssign(value=value):
                if value is not None:
                    yield from _evaluated(value, test)
            case ast.With(items=[first, *_]) | ast.AsyncWith(items=[first, *_]):
                yield from _evaluated(first.context_expr, test)
        scope = list(_own_scope([statement]))
        if any(isinstance(node, ast.Return | ast.Raise) for node in scope):
            return
        if _refers_to(scope, test.raising):
            return


def _evaluated(
    expr: ast.expr, test: _Test, *, awaited: bool = False, handed: bool = False
) -> Iterator[tuple[str, bool]]:
    """(name, called directly) for the tracked functions that evaluating `expr` runs, through calls
    and `await`s only. A tracked function is run when the test calls it so that its body starts
    (`_starts`), or when it, or a call of it, is a direct argument of code from outside the test
    (`_trusted`); an argument of a function defined in the test counts only if that function is run
    and does it itself."""
    if isinstance(expr, ast.Await):
        yield from _evaluated(expr.value, test, awaited=True, handed=handed)
    elif isinstance(expr, ast.Name):
        if handed and expr.id in test.tracked:
            yield expr.id, False
    elif isinstance(expr, ast.Call):
        callee = expr.func
        if isinstance(callee, ast.Name) and callee.id in test.tracked:
            if _starts(test.tracked[callee.id], awaited):
                yield callee.id, True
            elif handed:
                yield callee.id, False
        else:
            yield from _evaluated(callee, test)
        root = _root(callee)
        outside = isinstance(root, ast.Name) and root.id in test.trusted
        for argument in [*expr.args, *(keyword.value for keyword in expr.keywords)]:
            yield from _evaluated(argument, test, handed=outside)


def _starts(definition: _Def, awaited: bool) -> bool:
    """Whether a call of `definition` runs its body: a plain `def` when called, an `async def` when
    the call is awaited. Never for a generator (it runs only when iterated) or a decorated function
    (the decorator may have replaced it)."""
    if definition.decorator_list:
        return False
    if any(isinstance(node, ast.Yield | ast.YieldFrom) for node in _own_scope(definition.body)):
        return False
    return awaited or isinstance(definition, ast.FunctionDef)


def _root(callee: ast.expr) -> ast.expr:
    """`a` for `a.b.c`; anything else as it is."""
    while isinstance(callee, ast.Attribute):
        callee = callee.value
    return callee


def _own_scope(body: list[ast.stmt]) -> Iterator[ast.AST]:
    """The nodes of `body`'s scope: function, class and lambda bodies are not entered."""
    stack: list[ast.AST] = list(body)
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, _SCOPES):
            stack.extend(ast.iter_child_nodes(node))


def _bindings(root: ast.AST, skip: set[ast.AST]) -> Iterator[tuple[str, str, int]]:
    """Every name bound anywhere inside `root`, with the binding's form and line, except the
    definitions in `skip` (the test and its tracked functions). Every binding form in Python's
    grammar is here: none is resolved, so a missing form would only let a rebinding through, or
    trust code defined in the test, never hide a problem."""
    targets: dict[int, str] = {}
    for node in ast.walk(root):
        if isinstance(node, ast.comprehension):
            targets |= dict.fromkeys(map(id, ast.walk(node.target)), "comprehension variable")
        elif isinstance(node, ast.For | ast.AsyncFor):
            targets |= dict.fromkeys(map(id, ast.walk(node.target)), "`for` target")
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            targets |= dict.fromkeys(map(id, ast.walk(node.optional_vars)), "`with … as`")
        elif isinstance(node, ast.NamedExpr):
            targets[id(node.target)] = "`:=`"
    for node in ast.walk(root):
        line = getattr(node, "lineno", getattr(root, "lineno", 0))
        if isinstance(node, _DEFS) and node not in skip:
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
    # The scan found the tests it is about (101 at WF-02c), so it can't pass by finding none.
    assert tests >= 101


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


_HARNESS = """
import asyncio
from contextlib import asynccontextmanager, contextmanager, nullcontext, suppress

import pytest

ran = []


def mark():
    ran.append(True)


def _run(url, body):
    asyncio.run(body(None))


@contextmanager
def running(body):
    _run(None, body)
    yield


@asynccontextmanager
async def suppressed():
    try:
        yield
    except Exception:
        pass
"""


def _execute(source: str) -> dict[str, str]:
    """Run each test in `source` as Python, with a `_run` that runs the coroutine it is handed. Each
    ends "ran" (a coroutine called `mark()`), "passed" (it ended without that) or "skipped"."""
    namespace: dict[str, Any] = {}
    exec(compile(_HARNESS + source, "case.py", "exec"), namespace)  # noqa: S102 (the cases above)
    outcomes: dict[str, str] = {}
    for name, test in list(namespace.items()):
        if not name.startswith("test"):
            continue
        namespace["ran"].clear()
        try:
            result = test("scratch-url")
            if inspect.iscoroutine(result):
                asyncio.run(result)
        except pytest.skip.Exception:
            outcomes[name] = "skipped"
            continue
        outcomes[name] = "ran" if namespace["ran"] else "passed"
    return outcomes


def test_calls_that_may_not_be_reached_do_not_count() -> None:
    # Each case ends without running `body`. PR #145 review round 3: a context manager can
    # suppress an error raised before the call (`pytest.raises` does), and a `return` skips what
    # follows. Round 4: a later `with` item runs inside the earlier ones, and a compound statement
    # can `return`.
    source = """
def test_with_block(scratch_database_url):
    async def body(sessions):
        mark()
    with pytest.raises(ValueError):
        int("x")
        _run(scratch_database_url, body)

async def test_async_with_block(scratch_database_url):
    async def body(sessions):
        mark()
    async with suppressed():
        int("x")
        _run(scratch_database_url, body)

def test_after_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        return
        _run(scratch_database_url, body)
    wrapper()

def test_after_raise(scratch_database_url):
    async def body(sessions):
        mark()
    raise pytest.skip.Exception("later")
    _run(scratch_database_url, body)

def test_later_with_item(scratch_database_url):
    async def body(sessions):
        mark()
    with suppress(ValueError), int("x"), _run(scratch_database_url, body):
        pass

def test_after_if_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        if True:
            return
        _run(scratch_database_url, body)
    wrapper()

def test_after_with_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        with nullcontext():
            return
        _run(scratch_database_url, body)
    wrapper()

def test_after_try_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        try:
            return
        finally:
            pass
        _run(scratch_database_url, body)
    wrapper()

def test_after_while_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        while True:
            return
        _run(scratch_database_url, body)
    wrapper()

def test_after_match_return(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        match 1:
            case 1:
                return
        _run(scratch_database_url, body)
    wrapper()
"""
    outcomes = _execute(source)
    assert outcomes.pop("test_after_raise") == "skipped"
    assert set(outcomes.values()) == {"passed"}
    names = [name.removeprefix("test_") for name in [*outcomes, "test_after_raise"]]
    assert sorted(_check(source)) == sorted(_never_run(*(f"test_{name}" for name in names)))


@pytest.mark.filterwarnings("ignore:coroutine .* was never awaited:RuntimeWarning")
def test_calls_that_never_start_or_that_the_test_itself_receives_do_not_count() -> None:
    # Each case ends without running `body`: an `async def` or a generator called but never awaited
    # or iterated, a coroutine handed to code defined in the test (which the check reads, never
    # trusts), and a sibling handed to code that catches the error raised before its call.
    source = """
def test_unawaited_call(scratch_database_url):
    async def body(sessions):
        mark()
    body(None)

def test_unawaited_sibling(scratch_database_url):
    async def body(sessions):
        mark()
    async def wrapper():
        _run(scratch_database_url, body)
    wrapper()

def test_generator_sibling(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        yield
        _run(scratch_database_url, body)
    wrapper()

def test_handed_to_a_function_of_the_test(scratch_database_url):
    async def body(sessions):
        mark()
    def ignore(coroutine):
        pass
    ignore(body)

def test_handed_to_a_lambda_of_the_test(scratch_database_url):
    async def body(sessions):
        mark()
    ignore = lambda coroutine: None
    ignore(body)

def test_handed_to_a_name_bound_in_the_test(scratch_database_url):
    async def body(sessions):
        mark()
    ignore = id
    ignore(body)

def test_handed_sibling_whose_error_is_caught(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        int("x")
        _run(scratch_database_url, body)
    pytest.raises(ValueError, wrapper)
"""
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"passed"}
    assert sorted(_check(source)) == sorted(
        [
            *_never_run(*outcomes),
            "case.py::test_unawaited_sibling: `wrapper` is defined and never run",
        ]
    )


def test_a_function_reached_only_through_a_handed_coroutine_is_not_run() -> None:
    # PR #145's positive `test_through_siblings`, now negative: code that is handed a function may
    # run it so that a `return` or a caught error skips the rest, so a handed function isn't read.
    source = """
def test_publish(scratch_database_url):
    async def helper():
        mark()
    async def body(sessions):
        if sessions is None:
            return
        await helper()
    _run(scratch_database_url, body)
"""
    assert _execute(source) == {"test_publish": "passed"}
    assert _check(source) == ["case.py::test_publish: `helper` is defined and never run"]


def test_a_statement_that_runs_a_function_that_may_raise_ends_the_reading() -> None:
    # Review round 1 F1: a sibling the test calls raises (`pytest.skip`'s exception here, which
    # ends the test green), so the statements after the call never run. Its neighbours: the
    # `raise` inside a block or a nested function of the sibling, a sibling that calls one that
    # raises, and a raising coroutine handed to outside code.
    source = """
def test_called(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    abort()
    _run(scratch_database_url, body)

def test_in_a_block(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        if True:
            raise pytest.skip.Exception("later")
    abort()
    _run(scratch_database_url, body)

def test_in_a_nested_function(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        def inner():
            raise pytest.skip.Exception("later")
        inner()
    abort()
    _run(scratch_database_url, body)

def test_through_another_sibling(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    def setup():
        abort()
    setup()
    _run(scratch_database_url, body)

def test_handed(scratch_database_url):
    async def body(sessions):
        mark()
    async def abort(sessions):
        raise pytest.skip.Exception("later")
    _run(scratch_database_url, abort)
    _run(scratch_database_url, body)
"""
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"skipped"}
    assert sorted(_check(source)) == sorted(_never_run(*outcomes))


def test_a_call_counts_only_after_its_arguments_are_evaluated() -> None:
    # Review round 2 F1: an argument that raises is evaluated before the call is made, so the
    # call never hands `body` over (or never starts the sibling). Its neighbours: the raising
    # argument after the handed one, as a keyword, and a nested call that raises inside a runner.
    source = """
def test_before(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    _run(abort(), body)

def test_after(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    _run(scratch_database_url, body, abort())

def test_keyword(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    _run(scratch_database_url, body=body, extra=abort())

def test_sibling_never_started(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    def wrapper(value):
        _run(scratch_database_url, body)
    wrapper(abort())

def test_nested_runner(scratch_database_url):
    async def body(sessions):
        mark()
    async def abort(sessions):
        raise pytest.skip.Exception("later")
    print(_run(scratch_database_url, abort), body)
"""
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"skipped"}
    assert sorted(_check(source)) == sorted(_never_run(*outcomes))


def test_what_a_definition_evaluates_can_end_the_reading() -> None:
    # Review round 2 F2: a `def`'s defaults, a `class`'s bases and body, and a lambda's defaults
    # are evaluated when the statement runs, unlike the bodies of functions and lambdas.
    source = """
def test_default(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    def setup(value=abort()):
        pass
    _run(scratch_database_url, body)

def test_keyword_default(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    def setup(*, value=abort()):
        pass
    _run(scratch_database_url, body)

def test_base(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    class Setup(abort()):
        pass
    _run(scratch_database_url, body)

def test_class_keyword(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    class Setup(metaclass=abort()):
        pass
    _run(scratch_database_url, body)

def test_class_body(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    class Setup:
        value = abort()
    _run(scratch_database_url, body)

def test_class_body_raise(scratch_database_url):
    async def body(sessions):
        mark()
    class Setup:
        raise pytest.skip.Exception("later")
    _run(scratch_database_url, body)

def test_lambda_default(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    lambda value=abort(): None
    _run(scratch_database_url, body)
"""
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"skipped"}
    assert sorted(_check(source)) == sorted(_never_run(*outcomes))


def test_a_callee_the_test_changes_is_not_trusted() -> None:
    # Review round 1 F2: the test replaces an outside runner's attribute with its own code. Its
    # neighbours: through `setattr`, an alias, `vars()`, `globals()`, and an attribute store on
    # an outside object that rebinds a module name (here through its `__setattr__`).
    source = """
from types import SimpleNamespace

runner = SimpleNamespace(run=_run)
other = SimpleNamespace(run=_run)
third = SimpleNamespace(run=_run)
fourth = SimpleNamespace(run=_run)


class _Here:
    def __setattr__(self, name, value):
        globals()[name] = value


here = _Here()

def test_attribute(scratch_database_url):
    async def body(sessions):
        mark()
    runner.run = lambda url, coroutine: None
    runner.run(scratch_database_url, body)

def test_setattr(scratch_database_url):
    async def body(sessions):
        mark()
    setattr(other, "run", lambda url, coroutine: None)
    other.run(scratch_database_url, body)

def test_alias(scratch_database_url):
    async def body(sessions):
        mark()
    alias = third
    alias.run = lambda url, coroutine: None
    third.run(scratch_database_url, body)

def test_vars(scratch_database_url):
    async def body(sessions):
        mark()
    vars(fourth)["run"] = lambda url, coroutine: None
    fourth.run(scratch_database_url, body)

def test_globals(scratch_database_url):
    async def body(sessions):
        mark()
    globals()["_run"] = lambda url, coroutine: None
    _run(scratch_database_url, body)

def test_outside_object(scratch_database_url):
    async def body(sessions):
        mark()
    here._run = lambda url, coroutine: None
    _run(scratch_database_url, body)
"""
    for case in ["test_attribute", "test_setattr", "test_alias", "test_vars", "test_globals"]:
        # Each runs `body` without its replacing line, so the line alone makes it vacuous.
        lines = source.splitlines(keepends=True)
        start = next(i for i, line in enumerate(lines) if line.startswith(f"def {case}("))
        end = next(i for i in range(start, len(lines)) if "lambda url, coroutine" in lines[i])
        assert _execute("".join(lines[:end] + lines[end + 1 :]))[case] == "ran", case
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"passed"}
    assert sorted(_check(source)) == sorted(_never_run(*outcomes))


def test_a_decorated_function_fails_naming_it() -> None:
    source = """
def test_publish(scratch_database_url):
    async def body(sessions):
        mark()
    @(lambda function: lambda: None)
    def wrapper():
        _run(scratch_database_url, body)
    wrapper()
"""
    assert _execute(source) == {"test_publish": "passed"}
    assert _check(source) == [
        "case.py::test_publish: `wrapper` is decorated (line 6); the check can't tell what the "
        "decorator returns, so don't decorate it",
        "case.py::test_publish: `body` is defined and never run",
    ]


def test_coroutines_handed_to_outside_code_or_called_directly_run() -> None:
    # Each case runs `body`: handed to code from outside the test (a module function, a library,
    # an import), or reached through a sibling the test calls, or awaited.
    source = """
def test_passed(scratch_database_url):
    async def body(sessions):
        mark()
    _run(scratch_database_url, body)

def test_asyncio_run(scratch_database_url):
    async def body(sessions):
        mark()
    asyncio.run(body(None))

def test_returned_by_a_called_sibling(scratch_database_url):
    async def body(sessions):
        mark()
    def wrapper():
        assert scratch_database_url
        return _run(scratch_database_url, body)
    wrapper()

def test_first_with_item(scratch_database_url):
    async def body(sessions):
        mark()
    with running(body):
        pass

async def test_awaited(scratch_database_url):
    async def body(sessions):
        mark()
    await body(None)

def test_imported_runner(scratch_database_url):
    from asyncio import run
    async def body(sessions):
        mark()
    run(body(None))

def test_after_a_sibling_that_returns(scratch_database_url):
    async def body(sessions):
        mark()
    def setup():
        return 1
    setup()
    _run(scratch_database_url, body)

def test_after_changing_other_objects(scratch_database_url):
    from types import SimpleNamespace
    async def body(sessions):
        mark()
    state = SimpleNamespace()
    state.ready = True
    setattr(state, "patched", print)
    _run(scratch_database_url, body)

def test_beside_raising_code_it_does_not_run(scratch_database_url):
    async def body(sessions):
        mark()
    def abort():
        raise pytest.skip.Exception("later")
    def setup(value=len("abc")):
        return abort
    class Setup:
        value = str(1)
    _run(str(scratch_database_url), body)
"""
    outcomes = _execute(source)
    assert set(outcomes.values()) == {"ran"}
    assert unrun_coroutines(source, "case.py") == (len(outcomes), [])


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


def test_a_coroutine_passed_or_called_in_a_call_is_run() -> None:
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

def test_other_tests_are_not_checked(db):
    async def body(sessions):
        assert False
"""
    assert unrun_coroutines(source, "case.py") == (4, [])


def test_a_file_that_does_not_parse_fails() -> None:
    assert _check("def test_x(scratch_database_url):\n    async def body(:\n") == [
        "case.py: cannot be parsed (SyntaxError), so it can't be checked"
    ]
