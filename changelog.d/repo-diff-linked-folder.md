### Fixed
- The changes view no longer shows a file from outside the repository when a folder above a new
  file was swapped for a link to somewhere else: it checks the folders before and after reading
  the file, and shows nothing when either check finds a link.
