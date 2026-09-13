import bcrypt

# A real bcrypt hash of a value nothing can log in with. Verifying against it
# costs the same as verifying against a genuine one, which is the point: see
# verify_password_dummy below.
_DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt())


def hash_password(password: str) -> str:
    pwd_bytes = password.encode("utf-8")
    salt = bcrypt.gensalt()
    hashed_password = bcrypt.hashpw(password=pwd_bytes, salt=salt)

    return hashed_password.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    password_byte_enc = plain_password.encode("utf-8")
    hashed_password_bytes = hashed_password.encode("utf-8")

    return bcrypt.checkpw(
        password=password_byte_enc, hashed_password=hashed_password_bytes
    )


def verify_password_dummy() -> None:
    """Burn one bcrypt verification and throw the answer away.

    Login has to take the same time whether or not the email exists. Without
    this, "no such user" returns before any hashing happens and "wrong
    password" pays for a full bcrypt round — roughly 100 ms of difference that
    tells an attacker which email addresses have accounts, no matter what the
    response body says.
    """
    bcrypt.checkpw(b"not-a-real-password", _DUMMY_HASH)
