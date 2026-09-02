use crate::artifact_store::{ArtifactKind, ArtifactStore, StoreError, MAX_READ_RANGE};
use std::collections::BTreeMap;

pub const MAX_RANGE: usize = MAX_READ_RANGE;

#[derive(Clone, Debug)]
pub struct ProtocolRequest {
    pub method: String,
    pub uri: String,
    pub range_headers: Vec<String>,
}

impl ProtocolRequest {
    pub fn new(method: impl Into<String>, uri: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            uri: uri.into(),
            range_headers: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn get(uri: impl Into<String>) -> Self {
        Self::new("GET", uri)
    }

    #[cfg(test)]
    pub fn head(uri: impl Into<String>) -> Self {
        Self::new("HEAD", uri)
    }

    #[cfg(test)]
    pub fn with_range(mut self, range: impl Into<String>) -> Self {
        self.range_headers.push(range.into());
        self
    }

    pub fn with_ranges(mut self, ranges: Vec<String>) -> Self {
        self.range_headers = ranges;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl ProtocolResponse {
    #[cfg(test)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

pub fn serve(store: &ArtifactStore, request: ProtocolRequest) -> ProtocolResponse {
    if !matches!(request.method.as_str(), "GET" | "HEAD") {
        return error_response(405);
    }
    let (kind, handle) = match parse_uri(&request.uri) {
        Ok(parsed) => parsed,
        Err(status) => return error_response(status),
    };
    if store.validate_kind(handle, kind).is_err() {
        return error_response(404);
    }
    let artifact = match store.resolve(handle) {
        Ok(artifact) => artifact,
        Err(_) => return error_response(404),
    };
    let size = match usize::try_from(artifact.size) {
        Ok(size) => size,
        Err(_) => return range_error(artifact.size),
    };

    let selected = match parse_range_headers(&request.range_headers, size) {
        Ok(value) => value,
        Err(()) => return range_error(artifact.size),
    };
    let (status, start, length, content_range) = if let Some((start, end)) = selected {
        let length = end - start + 1;
        (
            206,
            start,
            length,
            Some(format!("bytes {start}-{end}/{}", artifact.size)),
        )
    } else {
        if request.method == "GET" && size > MAX_RANGE {
            return range_error(artifact.size);
        }
        (200, 0, size, None)
    };

    let body = if request.method == "HEAD" {
        Vec::new()
    } else {
        match store.read_range(handle, start, length) {
            Ok(bytes) => bytes,
            Err(StoreError::InvalidRange | StoreError::RangeTooLarge) => {
                return range_error(artifact.size)
            }
            Err(_) => return error_response(404),
        }
    };
    let mut headers = common_headers(&artifact.media_type, &artifact.revision_hash, length);
    if let Some(content_range) = content_range {
        headers.insert("content-range".into(), content_range);
    }
    ProtocolResponse {
        status,
        headers,
        body,
    }
}

fn parse_uri(uri: &str) -> Result<(ArtifactKind, &str), u16> {
    if !uri.is_ascii() || uri.contains(['?', '#', '%', '\\']) || !uri.starts_with("reviewasset://")
    {
        return Err(400);
    }
    let remainder = &uri["reviewasset://".len()..];
    let (authority, path) = remainder.split_once('/').ok_or(400_u16)?;
    if authority != "localhost" {
        return Err(400);
    }
    let mut segments = path.split('/');
    let kind = ArtifactKind::parse(segments.next().ok_or(400_u16)?).map_err(|_| 400_u16)?;
    let handle = segments.next().ok_or(400_u16)?;
    if segments.next().is_some() || !is_handle(handle) {
        return Err(400);
    }
    Ok((kind, handle))
}

fn is_handle(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_range_headers(
    range_headers: &[String],
    size: usize,
) -> Result<Option<(usize, usize)>, ()> {
    match range_headers {
        [] => Ok(None),
        [header] => {
            let value = header.strip_prefix("bytes=").ok_or(())?;
            if value.contains(',') {
                return Err(());
            }
            let (start, end) = value.split_once('-').ok_or(())?;
            if start.is_empty()
                || end.is_empty()
                || !start.bytes().all(|byte| byte.is_ascii_digit())
                || !end.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(());
            }
            let start = start.parse::<usize>().map_err(|_| ())?;
            let requested_end = end.parse::<usize>().map_err(|_| ())?;
            if start > requested_end || start >= size {
                return Err(());
            }
            let requested_length = requested_end
                .checked_sub(start)
                .and_then(|span| span.checked_add(1))
                .ok_or(())?;
            if requested_length > MAX_RANGE {
                return Err(());
            }
            Ok(Some((start, requested_end.min(size - 1))))
        }
        _ => Err(()),
    }
}

fn common_headers(
    media_type: &str,
    revision_hash: &str,
    content_length: usize,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("accept-ranges".into(), "bytes".into()),
        ("cache-control".into(), "private, immutable".into()),
        ("content-length".into(), content_length.to_string()),
        ("content-type".into(), media_type.to_owned()),
        ("etag".into(), format!("\"{revision_hash}\"")),
        ("x-content-type-options".into(), "nosniff".into()),
    ])
}

fn range_error(size: u64) -> ProtocolResponse {
    ProtocolResponse {
        status: 416,
        headers: BTreeMap::from([
            ("accept-ranges".into(), "bytes".into()),
            ("content-length".into(), "0".into()),
            ("content-range".into(), format!("bytes */{size}")),
        ]),
        body: Vec::new(),
    }
}

fn error_response(status: u16) -> ProtocolResponse {
    ProtocolResponse {
        status,
        headers: BTreeMap::from([("content-length".into(), "0".into())]),
        body: Vec::new(),
    }
}
