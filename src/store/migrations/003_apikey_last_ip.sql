-- Last client IP per API key (Lot 7b), as the listener normalized it (TRUST_PROXY: Cf-Connecting-IP, else the socket).
ALTER TABLE apikey ADD COLUMN lastIp TEXT;
