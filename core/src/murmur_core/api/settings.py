from fastapi import APIRouter, Body, Depends
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, get_runtime, require_user
from ..runtime import Runtime
from ..services import asr_client, llm_client

router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(require_user)])


@router.get("")
def get_settings(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    return rt.settings.get_public(db)


@router.get("/defaults")
def prompt_defaults(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    """Built-in prompt templates (for the current output language) so the UI can offer a starting point."""
    from ..services import prompts

    lang = rt.settings.get(db).general.output_language
    return {
        "prompts": {kind: prompts.default_prompt(kind if kind != "summary" else "summary", lang) for kind in ("summary", "daily", "todos")},
        "placeholders": ["{start}", "{end}", "{rooms}", "{now}", "{language}", "{transcript}", "{todos}"],
    }


@router.put("")
def put_settings(patch: dict = Body(...), db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    try:
        rt.settings.update(db, patch)
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise ApiError(422, f"{loc}: {first['msg']}", "invalid_settings")
    except ValueError as exc:
        raise ApiError(422, str(exc), "invalid_settings")
    return rt.settings.get_public(db)


@router.post("/test/asr")
def test_asr(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    return asr_client.check(rt.settings.get(db).asr, transport=rt.asr_transport)


@router.post("/test/llm")
def test_llm(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    return llm_client.check(rt.settings.get(db).llm, transport=rt.llm_transport)
