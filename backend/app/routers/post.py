import math
from datetime import datetime
from typing import Optional

from typing import Any

from fastapi import status, HTTPException, Response, Depends, APIRouter, Query
from sqlalchemy import ColumnElement, UnaryExpression, literal, select, func, or_
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas, oauth2, docs
from ..database import get_db

router = APIRouter(prefix="/posts", tags=["Posts"])


def _attach_counts(
    db: Session, post: models.Post, viewer: Optional[models.User] = None
) -> models.Post:
    """Stash the two facts that aren't columns onto one post, so the
    ``PostOut`` schema (from_attributes) can read them back.

    ``votes`` is how many the room gave it. ``voted`` is whether *this* reader
    is one of them — a property of the pair rather than of the post, which is
    why neither is stored on the row. For a single post two small lookups are
    cheaper and clearer than the aggregate ``page_of_posts`` needs; see the
    note there.
    """
    post.votes = (
        db.scalar(
            select(func.count(models.Vote.post_id)).where(
                models.Vote.post_id == post.id
            )
        )
        or 0
    )
    post.voted = (
        viewer is not None
        and (
            db.scalar(
                select(func.count())
                .select_from(models.Vote)
                .where(
                    models.Vote.post_id == post.id,
                    models.Vote.user_id == viewer.id,
                )
            )
            or 0
        )
        > 0
    )
    return post


def get_owned_post(
    id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Post:
    """Load a post by id (404 if missing) and check the caller owns it
    (403 if not). Shared by delete / put / patch so that rule lives in one
    place instead of being copy-pasted."""
    post = db.scalar(select(models.Post).where(models.Post.id == id))
    if post is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {id} does not exist",
        )
    if post.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to perform requested action",
        )
    return post


def visible_to(user: Optional[models.User]) -> ColumnElement[bool]:
    """Rows the caller is allowed to see: everything published, plus your own
    drafts. ``published`` is a real access rule, not a display hint — an
    unpublished post belongs to its author until they say otherwise."""
    if user is None:
        return models.Post.published.is_(True)
    return or_(models.Post.published.is_(True), models.Post.user_id == user.id)


# The text-search configuration, named once. Changing it means rebuilding the
# generated column, so it is not a thing to sprinkle around as a literal.
SEARCH_CONFIG = "english"

# How fast a ranking forgets. score = n / (hours_old + 2) ** gravity
#
# Two constants because two quantities age differently, and both were chosen by
# measuring them against the seeded feed rather than by copying somebody with a
# thousand times the traffic. Hacker News uses 1.8; at anything above about 1.2
# "warmest" on a feed this quiet collapses into "newest with the unvoted posts
# pushed to the bottom", which is a sort that reproduces another sort.
#
#   VOTE_GRAVITY 0.5 — a half-life of about six hours. A vote is a reaction and
#     it stales: this morning's post is still in contention this evening, last
#     week's is not. It also sits exactly at the boundary of the judgement that
#     matters here — three votes from yesterday just edge out one from an hour
#     ago, and at 0.6 that flips.
#
#   COMMENT_GRAVITY 0.25 — a half-life of about thirty hours, five times
#     gentler. A conversation is not a reaction; it is a thing you can still
#     join, so it ages more slowly. At the vote's gravity, one comment from six
#     minutes ago outranks a five-comment thread, which is not what anybody
#     means by "discussed".
#
# The +2 is the usual smoothing: without it a post minutes old divides by
# almost nothing and one vote takes the top of the feed.
#
# See docs/adr/0008-a-ranking-with-two-gravities.md for the measurements.
VOTE_GRAVITY = 0.5
COMMENT_GRAVITY = 0.25


def search_query(search: str) -> ColumnElement[Any]:
    """The caller's words as a tsquery.

    ``websearch_to_tsquery`` rather than ``to_tsquery`` because this is fed
    straight from a search box: it accepts what people actually type — bare
    words, "quoted phrases", ``or``, a leading ``-`` to exclude — and it never
    raises on punctuation. ``to_tsquery`` would turn a stray apostrophe into a
    500.
    """
    return func.websearch_to_tsquery(SEARCH_CONFIG, search)


def matching(search: str) -> ColumnElement[bool]:
    """Rows matching a search, or everything when the search says nothing.

    The second half is the interesting one. A query of only stop words —
    "the", "is", "a" — parses to an empty tsquery, and an empty tsquery
    matches no rows at all, so a reader who typed one honest word would get a
    blank feed and no explanation. ``numnode() = 0`` spots that case and lets
    the search fall away instead, which is also exactly what an empty box
    already does.
    """
    tsquery = search_query(search)
    return or_(
        func.numnode(tsquery) == 0,
        models.Post.search_vector.op("@@")(tsquery),
    )


def page_of_posts(
    db: Session,
    *,
    filters: tuple[ColumnElement[bool], ...],
    page: int,
    page_size: int,
    search: str = "",
    viewer: Optional[models.User] = None,
    as_of: Optional[datetime] = None,
    sort: schemas.PostSort = schemas.PostSort.new,
) -> dict[str, Any]:
    """One page of posts with their vote counts — in the shape ``PostPage``
    describes.

    Shared so the feed and a person's profile can't drift apart: the same
    ordering, the same pagination arithmetic, and above all the same visibility
    filter, which is an access rule rather than a display one.

    Ordering depends on whether anyone asked a question. With no search there
    is no notion of a better match, so the answer is whatever ``sort`` asks
    for — newest by default, or one of the two decaying rankings above. With
    one, relevance leads and recency breaks the ties — a good match from last
    year should outrank a poor one from this morning, but two equally good
    matches should come back newest first — and ``sort`` is ignored, because
    "the warmest, in relevance order" is not a thing anybody asked for.

    ``viewer`` decides one field and costs nothing to answer. The query already
    outer-joins every vote in order to count them, so "did this reader vote"
    is a second aggregate over rows that have been read anyway — no extra join,
    no correlated subquery, no second round trip per post.

    ``as_of`` holds the window still. Offset pagination counts from the top, so
    a post written between one page and the next pushes every later page down
    by one and the reader is handed a card they have already seen. That is
    ADR 0005's known cost, and it was correctly judged not worth paying for
    until something started *inserting* rows into a feed while it was being
    read — at which point it stops being a rare race and becomes one duplicate
    per insertion. One ``created_at <= :as_of`` is what stops it: later pages
    are served out of the feed as it stood when the reader arrived, which is
    what an infinite scroll means anyway.
    """
    offset = (page - 1) * page_size

    if as_of is not None:
        filters = (*filters, models.Post.created_at <= as_of)

    total = db.scalar(select(func.count()).select_from(models.Post).where(*filters))

    # Age in hours, as the ranking sees it. now() is the transaction's clock,
    # so every row in one page is scored against the same instant.
    hours_old = func.extract("epoch", func.now() - models.Post.created_at) / 3600.0

    # count(distinct ...) rather than count(...), and it is not caution: the
    # "discussed" sort joins comments as well as votes, and two outer joins
    # multiply — a post with three votes and two comments comes back as six
    # rows, and a plain count would call that six of each.
    vote_count = func.count(func.distinct(models.Vote.user_id))
    comment_count = func.count(func.distinct(models.Comment.id))

    order: tuple[UnaryExpression[Any], ...]
    if search:
        rank = func.ts_rank(models.Post.search_vector, search_query(search))
        order = (rank.desc(), models.Post.created_at.desc())
    elif sort is schemas.PostSort.warm:
        order = (
            (vote_count / func.power(hours_old + 2, VOTE_GRAVITY)).desc(),
            models.Post.created_at.desc(),
        )
    elif sort is schemas.PostSort.discussed:
        order = (
            (comment_count / func.power(hours_old + 2, COMMENT_GRAVITY)).desc(),
            models.Post.created_at.desc(),
        )
    else:
        order = (models.Post.created_at.desc(),)

    # bool_or over the same joined rows: true if any of this post's votes is
    # this reader's. A post with no votes at all comes back from the outer join
    # as a single NULL row, over which bool_or is NULL rather than false, so it
    # is coalesced — the honest answer to "have you voted on this" is never
    # "unknown".
    mine: ColumnElement[bool]
    if viewer is None:
        mine = literal(False)
    else:
        mine = func.coalesce(func.bool_or(models.Vote.user_id == viewer.id), False)

    stmt = (
        select(models.Post, vote_count.label("votes"), mine.label("voted"))
        .join(models.Vote, models.Vote.post_id == models.Post.id, isouter=True)
        .options(selectinload(models.Post.user))
        .where(*filters)
        .group_by(models.Post.id)
        .order_by(*order)
        .limit(page_size)
        .offset(offset)
    )
    # Only where it is needed. Every other page pays nothing for a sort nobody
    # asked for, and the fan-out the distinct counts guard against only exists
    # on this branch.
    if sort is schemas.PostSort.discussed and not search:
        stmt = stmt.join(
            models.Comment, models.Comment.post_id == models.Post.id, isouter=True
        )

    items = []
    for post, votes, voted in db.execute(stmt).all():
        post.votes = votes
        post.voted = bool(voted)
        items.append(post)

    pages = math.ceil(total / page_size) if total else 0
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "has_next": page < pages,
        "has_prev": page > 1,
    }


@router.get(
    "/",
    response_model=schemas.PostPage,
    summary="The feed",
    responses={
        200: docs.ok(docs.page(docs.POST_EXAMPLE)),
        **docs.errors(422),
    },
)
def get_posts(
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    search: str = Query("", max_length=100),
    sort: schemas.PostSort = Query(
        schemas.PostSort.new,
        description=(
            "`new` is newest first. `warm` and `discussed` are rankings that "
            "decay with age, so neither becomes a museum of whatever was "
            "popular two years ago. Ignored while searching, where relevance "
            "leads. See ADR 0008 for the two constants."
        ),
    ),
    as_of: Optional[datetime] = Query(
        None,
        description=(
            "Only posts written at or before this moment. Send back the "
            "`created_at` of the newest post the first page gave you, and "
            "every page after it is served out of the same feed — otherwise a "
            "post written while you scroll pushes the rest down and you are "
            "handed one you have already read. URL-encode it: a timestamp "
            "carries a `+` in its offset, and a bare `+` in a query string "
            "decodes to a space."
        ),
    ),
) -> dict[str, Any]:
    """The feed, and the search over it.

    Searching covers the title *and* the body: the old title-only ``LIKE``
    meant a post about repairing a kettle couldn't be found by the word
    "kettle" unless it happened to be in the heading, which is not what anyone
    typing into a search box expects.
    """
    return page_of_posts(
        db,
        filters=(matching(search), visible_to(current_user)),
        page=page,
        page_size=page_size,
        search=search,
        viewer=current_user,
        as_of=as_of,
        sort=sort,
    )


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    response_model=schemas.PostOut,
    summary="Write a post",
    responses={
        201: docs.ok({**docs.POST_EXAMPLE, "votes": 0}),
        **docs.errors(401, 422),
    },
)
def create_posts(
    post: schemas.PostCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Post:
    """Create a post, attributed to the token's owner.

    `published: false` saves it as a draft — which is an access rule, not a
    display hint: it is returned to you and to nobody else.
    """
    new_post = models.Post(user_id=current_user.id, **post.model_dump())
    db.add(new_post)
    db.commit()
    db.refresh(new_post)
    new_post.votes = 0  # a brand new post has no votes,
    new_post.voted = False  # and its author has not voted for it
    return new_post


@router.get(
    "/{id}",
    response_model=schemas.PostOut,
    summary="One post",
    responses={200: docs.ok(docs.POST_EXAMPLE), **docs.errors(404)},
)
def get_post(
    id: int,
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
) -> models.Post:
    """One post, with its vote count.

    Public, like the feed — a token is optional and only changes whether your
    own drafts are reachable.
    """
    post = db.scalar(
        select(models.Post)
        .options(selectinload(models.Post.user))
        .where(models.Post.id == id, visible_to(current_user))
    )
    if post is None:
        # Someone else's draft is reported as missing, not as forbidden: a 403
        # would confirm that a post with this id exists, which is the thing the
        # author hasn't published yet.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {id} was not found",
        )
    return _attach_counts(db, post, current_user)


@router.delete(
    "/{id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a post",
    responses={
        204: {"description": "Gone, along with its comments and its votes."},
        **docs.errors(401, 403, 404),
    },
)
def delete_post(
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
) -> Response:
    """Delete a post of yours.

    The comments and votes on it go too, by `ON DELETE CASCADE` at the
    database, so it holds whoever issues the DELETE.
    """
    db.delete(post)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{id}",
    response_model=schemas.PostOut,
    summary="Replace a post",
    responses={200: docs.ok(docs.POST_EXAMPLE), **docs.errors(401, 403, 404, 422)},
)
def update_post(
    updated_post: schemas.PostCreate,
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Post:
    """Replace a post of yours, in full.

    Every field of the body is applied, so anything you leave out goes back to
    its default. `PATCH` is the one that changes only what you send.
    """
    # get_owned_post already resolved the caller in order to check ownership,
    # and FastAPI caches a dependency for the life of a request — so naming it
    # here is a second reference to one lookup, not a second lookup. It is
    # named because `voted` is about the reader, and the owner of a post is a
    # reader like any other.
    # PUT = full replacement: every field of PostCreate is applied.
    for key, value in updated_post.model_dump().items():
        setattr(post, key, value)
    db.commit()
    db.refresh(post)
    return _attach_counts(db, post, current_user)


@router.patch(
    "/{id}",
    response_model=schemas.PostOut,
    summary="Change part of a post",
    responses={
        200: docs.ok(docs.POST_EXAMPLE),
        **docs.errors(400, 401, 403, 404, 422),
    },
)
def patch_post(
    payload: schemas.PostUpdate,
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Post:
    """Change part of a post of yours.

    Only the fields actually present in the body move. An empty body is a 400
    rather than a no-op 200: it almost always means the caller built the
    request wrong.
    """
    # PATCH = partial update: only the fields the client actually sent.
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update",
        )
    for key, value in data.items():
        setattr(post, key, value)
    db.commit()
    db.refresh(post)
    return _attach_counts(db, post, current_user)
