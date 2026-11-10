from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import SESSION_COOKIE, ApiError, _session_valid, get_db, get_runtime, require_user
from ..models import AuthRow, SessionRow
from ..runtime import Runtime
from ..security import hash_password, hash_token, new_token, verify_password
from ..timeutil import utcnow

router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_DAYS = 30


class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6, max_length=200)


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _login(db: Session, response: Response, rt: Runtime) -> None:
    token = new_token()
    db.add(SessionRow(token_hash=hash_token(token), expires_at=utcnow() + timedelta(days=SESSION_DAYS)))
    db.flush()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=rt.config.cookie_secure,
        path="/",
    )


@router.get("/status")
def status(request: Request, db: Session = Depends(get_db)):
    return {
        "setup_required": db.query(AuthRow).first() is None,
        "authenticated": _session_valid(db, request.cookies.get(SESSION_COOKIE)),
    }


@router.post("/setup")
def setup(body: PasswordIn, response: Response, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    if db.query(AuthRow).first() is not None:
        raise ApiError(409, "password already set", "already_setup")
    if len(body.password) < 6:
        raise ApiError(422, "password must be at least 6 characters", "weak_password")
    db.add(AuthRow(password_hash=hash_password(body.password)))
    db.flush()
    _login(db, response, rt)
    return {"ok": True}


@router.post("/login")
def login(body: PasswordIn, request: Request, response: Response, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    key = _client_key(request)
    wait = rt.limiter.retry_after(key)
    if wait:
        raise ApiError(429, f"too many attempts, retry in {wait}s", "rate_limited", headers={"Retry-After": str(wait)})
    row = db.query(AuthRow).first()
    if row is None:
        raise ApiError(409, "setup required", "setup_required")
    if not verify_password(body.password, row.password_hash):
        rt.limiter.failed(key)
        raise ApiError(401, "wrong password", "bad_password")
    rt.limiter.succeeded(key)
    _login(db, response, rt)
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.query(SessionRow).filter(SessionRow.token_hash == hash_token(token)).delete()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/password", dependencies=[Depends(require_user)])
def change_password(body: ChangePasswordIn, db: Session = Depends(get_db)):
    row = db.query(AuthRow).first()
    if row is None or not verify_password(body.old_password, row.password_hash):
        raise ApiError(401, "wrong password", "bad_password")
    row.password_hash = hash_password(body.new_password)
    db.query(SessionRow).delete()  # sign everyone out; the caller logs in again
    return {"ok": True}
