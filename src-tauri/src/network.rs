use std::collections::HashSet;
use std::net::{Ipv4Addr, UdpSocket};

/// Includes IPv4 link-local addresses used by Windows APIPA and macOS self-assignment.
pub fn usable_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && ip.octets()[0] != 0
}

pub fn effective_mask(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    // RFC 3927: every 169.254 address belongs to the same on-link /16.
    if ip.is_link_local() {
        Ipv4Addr::new(255, 255, 0, 0)
    } else {
        mask
    }
}

pub fn broadcast(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) | !u32::from(effective_mask(ip, mask)))
}

pub fn matching_interface(
    target: Ipv4Addr,
    interfaces: &[(Ipv4Addr, Ipv4Addr)],
) -> Option<Ipv4Addr> {
    interfaces
        .iter()
        .filter(|(ip, mask)| {
            let mask = u32::from(effective_mask(*ip, *mask));
            mask != 0 && u32::from(*ip) & mask == u32::from(target) & mask
        })
        .max_by_key(|(ip, mask)| u32::from(effective_mask(*ip, *mask)).count_ones())
        .map(|(ip, _)| *ip)
}

pub fn discovery_sender(ip: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let socket = UdpSocket::bind((ip, 0))?;
    socket.set_broadcast(true)?;
    socket.set_multicast_loop_v4(false)?;
    socket.set_multicast_ttl_v4(1)?;
    // Binding the source address alone does not select the multicast egress on all OSes.
    socket2::SockRef::from(&socket).set_multicast_if_v4(&ip)?;
    Ok(socket)
}

/// Retry failed joins and refresh memberships after USB hotplug / address changes.
pub fn refresh_memberships(
    socket: &UdpSocket,
    group: Ipv4Addr,
    joined: &mut HashSet<Ipv4Addr>,
    current: &HashSet<Ipv4Addr>,
) {
    joined.retain(|ip| {
        if current.contains(ip) {
            true
        } else {
            let _ = socket.leave_multicast_v4(&group, ip);
            false
        }
    });
    for ip in current.difference(joined).copied().collect::<Vec<_>>() {
        if socket.join_multicast_v4(&group, &ip).is_ok() {
            joined.insert(ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn link_local_is_usable_and_broadcasts_across_the_entire_link() {
        let ip = Ipv4Addr::new(169, 254, 18, 3);
        assert!(usable_ipv4(ip));
        assert_eq!(
            broadcast(ip, Ipv4Addr::new(255, 255, 255, 0)),
            Ipv4Addr::new(169, 254, 255, 255)
        );
        for ip in [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::UNSPECIFIED,
            Ipv4Addr::BROADCAST,
            Ipv4Addr::new(239, 1, 2, 3),
        ] {
            assert!(!usable_ipv4(ip));
        }
    }
    #[test]
    fn reply_selects_usb_link_with_different_third_octets_and_longest_lan_prefix() {
        let usb = Ipv4Addr::new(169, 254, 18, 3);
        let office = Ipv4Addr::new(10, 20, 1, 2);
        let specific = Ipv4Addr::new(10, 20, 30, 2);
        let interfaces = [
            (office, Ipv4Addr::new(255, 255, 0, 0)),
            (specific, Ipv4Addr::new(255, 255, 255, 0)),
            (usb, Ipv4Addr::new(255, 255, 0, 0)),
        ];
        assert_eq!(
            matching_interface(Ipv4Addr::new(169, 254, 207, 8), &interfaces),
            Some(usb)
        );
        assert_eq!(
            matching_interface(Ipv4Addr::new(10, 20, 30, 5), &interfaces),
            Some(specific)
        );
        assert_eq!(
            matching_interface(Ipv4Addr::new(192, 168, 8, 5), &interfaces),
            None
        );
        assert_eq!(
            broadcast(office, interfaces[0].1),
            Ipv4Addr::new(10, 20, 255, 255)
        );
    }
    #[test]
    fn memberships_track_removal_and_retry_failed_interfaces() {
        let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
        let group = Ipv4Addr::new(239, 255, 255, 250);
        let absent = Ipv4Addr::new(192, 0, 2, 44);
        let mut joined = HashSet::from([absent]);
        refresh_memberships(&socket, group, &mut joined, &HashSet::new());
        assert!(joined.is_empty());
        refresh_memberships(&socket, group, &mut joined, &HashSet::from([absent]));
        assert!(
            !joined.contains(&absent),
            "failed joins must remain eligible for retry"
        );
    }

    #[test]
    fn source_bound_discovery_socket_can_exchange_unicast_packets() {
        let listener = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let sender = discovery_sender(Ipv4Addr::LOCALHOST).unwrap();
        sender
            .send_to(b"wenbox_search_room", listener.local_addr().unwrap())
            .unwrap();
        let mut bytes = [0; 128];
        let (len, source) = listener.recv_from(&mut bytes).unwrap();
        assert_eq!(&bytes[..len], b"wenbox_search_room");
        assert_eq!(source.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
}
