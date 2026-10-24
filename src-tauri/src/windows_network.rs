//! Supplement if-addrs with Windows' IPv4 table. if-addrs 0.13 only keeps
//! DadStatePreferred addresses, which can omit an OS-configured APIPA address.
use std::{io, mem, net::Ipv4Addr};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
    NetworkManagement::IpHelper::{
        GetIpAddrTable, MIB_IPADDRTABLE, MIB_IPADDRROW_XP,
        MIB_IPADDR_DELETED, MIB_IPADDR_DISCONNECTED,
    },
};

pub fn ipv4_rows() -> io::Result<Vec<(u32, Ipv4Addr, Ipv4Addr)>> {
    let mut size = 16 * 1024u32;
    // The address table can grow between calls during USB hotplug.
    for _ in 0..4 {
        if size as usize > 16 * 1024 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "IPv4 table too large"));
        }
        // u64 storage provides sufficient alignment for the Windows table and rows.
        let mut buffer = vec![0u64; (size as usize).div_ceil(mem::size_of::<u64>())];
        let capacity = buffer.len() * mem::size_of::<u64>();
        size = capacity as u32;
        let table = buffer.as_mut_ptr().cast::<MIB_IPADDRTABLE>();
        // SAFETY: the buffer is aligned, writable, and its byte capacity is passed to Windows.
        let result = unsafe { GetIpAddrTable(table, &mut size, 0) };
        if result == ERROR_INSUFFICIENT_BUFFER { continue; }
        if result != NO_ERROR { return Err(io::Error::from_raw_os_error(result as i32)); }
        let offset = mem::offset_of!(MIB_IPADDRTABLE, table);
        if capacity < mem::size_of::<MIB_IPADDRTABLE>() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Truncated IPv4 table"));
        }
        // SAFETY: successful API call initialized the table header inside the checked buffer.
        let count = unsafe { (*table).dwNumEntries as usize };
        if count > (capacity - offset) / mem::size_of::<MIB_IPADDRROW_XP>() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid IPv4 row count"));
        }
        // SAFETY: rows stay within the allocation, with alignment and count checked above.
        let rows = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(offset).cast::<MIB_IPADDRROW_XP>(), count)
        };
        return Ok(rows.iter().filter_map(|row| {
            if u32::from(row.wType) & (MIB_IPADDR_DELETED | MIB_IPADDR_DISCONNECTED) != 0 { return None; }
            // dwAddr/dwMask contain network-order bytes, not host-order integers.
            let ip = Ipv4Addr::from(row.dwAddr.to_ne_bytes());
            if !super::network::usable_ipv4(ip) { return None; }
            // Do not advertise tentative, stale or otherwise unbindable addresses.
            std::net::UdpSocket::bind((ip, 0)).ok()?;
            Some((row.dwIndex, ip, Ipv4Addr::from(row.dwMask.to_ne_bytes())))
        }).collect());
    }
    Err(io::Error::new(io::ErrorKind::WouldBlock, "IPv4 table kept changing"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_windows_ipv4_table() {
        let rows = super::ipv4_rows().expect("Windows IPv4 enumeration failed");
        for (_, ip, _) in rows { assert!(super::super::network::usable_ipv4(ip)); }
    }
}
