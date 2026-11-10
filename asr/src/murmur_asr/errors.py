"""Errors carrying the HTTP status and machine code of the contract's error body."""


class AsrError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class InvalidAudio(AsrError):
    status = 400
    code = "invalid_audio"


class UnsupportedAudio(AsrError):
    status = 415
    code = "unsupported_audio"


class PayloadTooLarge(AsrError):
    status = 413
    code = "payload_too_large"


class Unauthorized(AsrError):
    status = 401
    code = "unauthorized"


class Busy(AsrError):
    status = 503
    code = "busy"


class NotReady(AsrError):
    status = 503
    code = "loading"
